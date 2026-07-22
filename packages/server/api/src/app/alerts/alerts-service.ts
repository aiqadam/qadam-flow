import { apDayjsDuration } from '@aiqadam/server-utils'
import { Alert, AlertChannel, ApId, apId, CreateAlertParams, ErrorCode, FlowRun, flowStructureUtil, isFailedState, ListAlertsParams, ProjectType, QadamFlowError, SeekPage } from '@aiqadam/shared'
import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import { FastifyBaseLogger } from 'fastify'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { redisConnections } from '../database/redis-connections'
import { flowVersionService } from '../flows/flow-version/flow-version.service'
import { domainHelper } from '../helper/domain-helper'
import { isSmtpConfigured } from '../helper/mail/email-sender/smtp-email-sender'
import { emailService } from '../helper/mail/email-service'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { AlertEntity } from './alerts-entity'

dayjs.extend(timezone)

const repo = repoFactory(AlertEntity)
const DAY_IN_SECONDS = apDayjsDuration(1, 'day').asSeconds()
const alertEventKey = (flowVersionId: string): string => `flow_fail_count:${flowVersionId}`

export const alertsService = (log: FastifyBaseLogger) => ({
    async sendAlertOnRunFinish(flowRun: FlowRun): Promise<void> {
        if (!isFailedState(flowRun.status)) {
            return
        }
        if (!isSmtpConfigured()) {
            log.info({ flowRunId: flowRun.id }, '[alertsService#sendAlertOnRunFinish] SMTP not configured, skipping alert')
            return
        }

        const redisConnection = await redisConnections.useExisting()
        const failureKey = alertEventKey(flowRun.flowVersionId)
        const numberOfFailures = await redisConnection.incrby(failureKey, 1)
        await redisConnection.expire(failureKey, DAY_IN_SECONDS)
        if (numberOfFailures > 1) {
            return
        }

        const alerts = await this.list({ projectId: flowRun.projectId, cursor: undefined, limit: MAX_ALERT_RECEIVERS })
        const emails = alerts.data.filter((alert) => alert.channel === AlertChannel.EMAIL).map((alert) => alert.receiver)
        if (emails.length === 0) {
            return
        }

        const project = await projectService(log).getOneOrThrow(flowRun.projectId)
        const flowVersion = await flowVersionService(log).getOneOrThrow(flowRun.flowVersionId)
        const failedStep = flowRun.failedStep
        const failedStepNumber = failedStep ? flowStructureUtil.getStepNumber(flowVersion.trigger, failedStep.name) : 0
        const runUrl = await domainHelper.getPublicUrl({
            path: `projects/${flowRun.projectId}/runs/${flowRun.id}`,
        })

        await emailService(log).sendFlowIssueAlert({
            emails,
            platformId: project.platformId,
            vars: {
                projectName: project.displayName,
                flowName: flowVersion.displayName,
                runUrl,
                createdAt: dayjs(flowRun.created).tz('America/Los_Angeles').format('DD MMM YYYY, HH:mm [PT]'),
                failedStepDisplayName: failedStep?.displayName ?? '',
                failedStepNumber: failedStepNumber > 0 ? `${failedStepNumber}` : '',
                failedStepMessage: failedStep?.message ?? '',
            },
        })
    },

    async add({ projectId, channel, receiver }: CreateAlertParams): Promise<void> {
        const normalizedReceiver = receiver.toLowerCase()
        const project = await projectService(log).getOneOrThrow(projectId)
        if (project.type === ProjectType.PERSONAL) {
            const owner = await userService(log).getOneOrFail({ id: project.ownerId })
            const identity = await userIdentityService(log).getOneOrFail({ id: owner.identityId })
            if (identity.email.toLowerCase() !== normalizedReceiver) {
                throw new QadamFlowError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        message: 'Personal projects only allow the project owner as alert receiver',
                    },
                })
            }
        }
        const existingAlert = await repo()
            .createQueryBuilder('alert')
            .where('alert."projectId" = :projectId', { projectId })
            .andWhere('LOWER(alert.receiver) = :receiver', { receiver: normalizedReceiver })
            .getOne()
        if (existingAlert) {
            throw new QadamFlowError({
                code: ErrorCode.EXISTING_ALERT_CHANNEL,
                params: {
                    email: normalizedReceiver,
                },
            })
        }

        await repo().createQueryBuilder()
            .insert()
            .into(AlertEntity)
            .values({
                id: apId(),
                channel,
                projectId,
                receiver: normalizedReceiver,
                created: dayjs().toISOString(),
            })
            .execute()
    },

    async list({ projectId, cursor, limit }: ListAlertsParams): Promise<SeekPage<Alert>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor ?? null)
        const paginator = buildPaginator({
            entity: AlertEntity,
            query: {
                limit: limit ?? 10,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const query = repo().createQueryBuilder(AlertEntity.options.name).where({ projectId })
        const { data, cursor: newCursor } = await paginator.paginate(query)
        return paginationHelper.createPage<Alert>(data, newCursor)
    },

    async delete({ alertId }: { alertId: ApId }): Promise<void> {
        await repo().delete({ id: alertId })
    },
})

const MAX_ALERT_RECEIVERS = 50
