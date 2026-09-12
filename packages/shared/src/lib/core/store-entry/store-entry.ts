import type { ProjectId } from '../../management/project/project'
import type { BaseModel } from '../common/base-model'
import type { ApId } from '../common/id-generator'

export type StoreEntryId = ApId

export const STORE_KEY_MAX_LENGTH = 128
export const STORE_VALUE_MAX_SIZE = 512 * 1024
export const MAX_STORE_TTL_SECONDS = 365 * 24 * 60 * 60

export type StoreEntry = {
    key: string
    projectId: ProjectId
    value: unknown
    // Null means "keeps forever", which is every entry written before TTL existed.
    expiresAt: string | null
} & BaseModel<StoreEntryId>