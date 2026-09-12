import { z } from 'zod'
import { MAX_STORE_TTL_SECONDS, STORE_KEY_MAX_LENGTH } from '../store-entry'

export const PutStoreEntryRequest = z.object({
    key: z.string().max(STORE_KEY_MAX_LENGTH),
    value: z.any().optional(),
    // Absent keeps the entry forever, which is what every entry written before TTL
    // existed does. Capped at a year so a typo cannot mean "effectively never".
    ttlSeconds: z.number().int().positive().max(MAX_STORE_TTL_SECONDS).optional(),
})

export type PutStoreEntryRequest = z.infer<typeof PutStoreEntryRequest>

export const GetStoreEntryRequest = z.object({
    key: z.string(),
})

export type GetStoreEntryRequest = z.infer<typeof GetStoreEntryRequest>

export const DeleteStoreEntryRequest = z.object({
    key: z.string(),
})

export type DeleteStoreEntryRequest = z.infer<typeof DeleteStoreEntryRequest>
