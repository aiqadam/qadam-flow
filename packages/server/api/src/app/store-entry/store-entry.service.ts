import {
    apId,
    isNil,
    ProjectId,
    PutStoreEntryRequest,
    sanitizeObjectForPostgresql,
    StoreEntry,
} from '@aiqadam/shared'
import { repoFactory } from '../core/db/repo-factory'
import { StoreEntryEntity } from './store-entry-entity'

const storeEntryRepo = repoFactory<StoreEntry>(StoreEntryEntity)

function toExpiry(ttlSeconds: number | undefined): string | null {
    return isNil(ttlSeconds) ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString()
}

export const storeEntryService = {
    async upsert({ projectId, request }: { projectId: ProjectId, request: PutStoreEntryRequest }): Promise<StoreEntry | null> {
        const value = sanitizeObjectForPostgresql(request.value)
        const expiresAt = toExpiry(request.ttlSeconds)
        const insertResult = await storeEntryRepo().upsert({
            id: apId(),
            key: request.key,
            value,
            projectId,
            expiresAt,
        }, ['projectId', 'key'])

        return {
            projectId,
            key: request.key,
            value,
            expiresAt,
            id: insertResult.identifiers[0].id,
            created: insertResult.generatedMaps[0].created,
            updated: insertResult.generatedMaps[0].updated,
        }
    },

    // The dedup / lock / idempotency-key primitive: one statement, made atomic by
    // uq_store_entry_project_id_key. No lock and no transaction — the DO UPDATE is
    // conditional, so it only takes over an entry that has already expired, and
    // RETURNING yields a row exactly when we won.
    async putIfAbsent({ projectId, request }: { projectId: ProjectId, request: PutStoreEntryRequest }): Promise<PutIfAbsentResult> {
        const value = sanitizeObjectForPostgresql(request.value)
        const expiresAt = toExpiry(request.ttlSeconds)
        const inserted: StoreEntry[] = await storeEntryRepo().query(
            `INSERT INTO "store-entry" ("id", "created", "updated", "key", "projectId", "value", "expiresAt")
             VALUES ($1, now(), now(), $2, $3, $4, $5)
             ON CONFLICT ("projectId", "key") DO UPDATE
             SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt", "updated" = now()
             WHERE "store-entry"."expiresAt" IS NOT NULL AND "store-entry"."expiresAt" <= now()
             RETURNING *`,
            [apId(), request.key, projectId, JSON.stringify(value ?? null), expiresAt],
        )
        if (inserted.length > 0) {
            return { stored: true, entry: inserted[0] }
        }
        // Zero rows means a live entry already held the key. Returning it lets the
        // caller see what won without a second round-trip deciding anything.
        const existing = await this.getOne({ projectId, key: request.key })
        return { stored: false, entry: existing }
    },
    async getOne({
        projectId,
        key,
    }: {
        projectId: ProjectId
        key: string
    }): Promise<StoreEntry | null> {
        // Expiry is enforced on read as well as by the sweep, so a swept-but-not-yet
        // entry never serves a stale value.
        return storeEntryRepo().createQueryBuilder('store_entry')
            .where('store_entry."projectId" = :projectId', { projectId })
            .andWhere('store_entry.key = :key', { key })
            .andWhere('(store_entry."expiresAt" IS NULL OR store_entry."expiresAt" > now())')
            .getOne()
    },

    // The one query here that is deliberately not scoped by projectId. It is a janitor
    // run from a scheduled job, not from a request, and it selects rows purely by their
    // own expiry — so there is no principal whose tenant it could be narrowed to, and
    // narrowing it would leave every other project's expired rows behind forever.
    // It is reachable from no controller; keep it that way.
    async deleteExpired({ limit }: { limit: number }): Promise<number> {
        const deleted = await storeEntryRepo().createQueryBuilder()
            .delete()
            .where('"id" IN (SELECT "id" FROM "store-entry" WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() LIMIT :limit)', { limit })
            .execute()
        return deleted.affected ?? 0
    },
    async delete({
        projectId,
        key,
    }: {
        projectId: ProjectId
        key: string
    }): Promise<void> {
        await storeEntryRepo().delete({
            projectId,
            key,
        })
    },
}
export type PutIfAbsentResult = {
    stored: boolean
    entry: StoreEntry | null
}
