import { apId } from '@aiqadam/shared'
import { In } from 'typeorm'
import { repoFactory } from '../../../core/db/repo-factory'
import { tagService } from '../tag-service'
import { QadamTagEntity } from './qadam-tag.entity'


const qadamTagsRepo = repoFactory(QadamTagEntity)

export const qadamTagService = {
    async set(platformId: string, qadamName: string, tags: string[]): Promise<void> {
        const tagIds = await Promise.all(tags.map(tag => tagService.upsert(platformId, tag).then(tag => tag.id)))
        await qadamTagsRepo().delete({ qadamName, platformId })
        await qadamTagsRepo().upsert(tagIds.map(tagId => ({ id: apId(), tagId, qadamName, platformId })), ['tagId', 'qadamName'])
    },
    async findByPlatform(platformId: string):  Promise<Record<string, string[]>> {
        const qadamTags = await qadamTagsRepo().findBy({ platformId })
        const tagIds = Array.from(new Set(qadamTags.map(qadamTag => qadamTag.tagId)))
        const tags = await tagService.findNamesByIds(tagIds)
        return qadamTags.reduce((acc, qadamTag) => {
            acc[qadamTag.qadamName] = acc[qadamTag.qadamName] || []
            acc[qadamTag.qadamName].push(tags[qadamTag.tagId])
            return acc
        }, {} as Record<string, string[]>)
    },
    async deleteByTagId(tagId: string): Promise<void> {
        await qadamTagsRepo().delete({ tagId })
    },
    async findByPlatformAndTags(platformId: string, qadamTags: string[]): Promise<string[]> {
        const tagIds = await tagService.convertIdsToNames(platformId, qadamTags)
        const qadamTagEntities = await qadamTagsRepo().findBy({
            platformId,
            tagId: In(tagIds),
        })
        return qadamTagEntities.map(qadamTag => qadamTag.qadamName)
    },

}