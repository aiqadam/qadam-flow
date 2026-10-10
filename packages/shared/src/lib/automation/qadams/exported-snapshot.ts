import { z } from 'zod'
import { BoundedArray, STEP_NAME_REGEX } from '../../core/common'
import { formErrors } from '../../form-errors'
import { VersionType } from './dto/qadam-requests'
import { qadamVersionParser } from './qadam-version'

// ADR-0004 "Export and import": the two optional fields an export adds to a flow in a template.
// Both are read by an importer that did not write them, so both are bounded and shaped here, once,
// for every reader (the MCP import, the `IMPORT_FLOW` request, the web importer).
export const EXPORTED_UNRESOLVED_MAX_STEPS = 10_000
export const EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES = 32
export const EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES = 1024 * 1024
const QADAM_NAME_MAX_LENGTH = 214
const STEP_NAME_MAX_LENGTH = 256

export const embeddedSnapshotMetadataUtil = {
    key: ({ name, version }: { name: string, version: string }): string => `${name}@${version}`,
}

// A step whose snapshot pin the exporting instance could not move to a release that passes the
// props check. The importer marks it "update this step". `pin` is what the source flow had.
export const ExportedUnresolvedStep = z.object({
    stepName: z.string().max(STEP_NAME_MAX_LENGTH).regex(STEP_NAME_REGEX),
    qadamName: z.string().max(QADAM_NAME_MAX_LENGTH),
    pin: VersionType,
})
export type ExportedUnresolvedStep = z.infer<typeof ExportedUnresolvedStep>

export const ExportedUnresolvedSteps = BoundedArray({ element: ExportedUnresolvedStep, max: EXPORTED_UNRESOLVED_MAX_STEPS })

// What a props check reads of a qadam's `metadata.json`: each action's and trigger's props. The rest
// of the file is kept as it came and never interpreted here.
const PropsOwner = z.looseObject({
    props: z.record(z.string(), z.looseObject({ type: z.string() })),
})

export const EmbeddedSnapshotMetadata = z.looseObject({
    name: z.string().max(QADAM_NAME_MAX_LENGTH),
    version: z.string().refine((version) => qadamVersionParser.isSnapshot({ version }), formErrors.snapshotMetadataInvalid),
    actions: z.record(z.string(), PropsOwner),
    triggers: z.record(z.string(), PropsOwner),
}).superRefine((metadata, ctx) => {
    if (JSON.stringify(metadata).length > EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES) {
        ctx.addIssue({ code: 'custom', message: formErrors.snapshotMetadataTooLarge })
    }
})
export type EmbeddedSnapshotMetadata = z.infer<typeof EmbeddedSnapshotMetadata>

// Keyed `name@version`; an entry that names another coordinate than its key is refused, so a key
// can be trusted to say which snapshot the entry describes.
export const EmbeddedSnapshotMetadataMap = z.record(z.string().max(QADAM_NAME_MAX_LENGTH + 1 + 44), EmbeddedSnapshotMetadata)
    .superRefine((entries, ctx) => {
        const keys = Object.keys(entries)
        if (keys.length > EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES) {
            ctx.addIssue({ code: 'custom', message: formErrors.snapshotMetadataTooLarge })
            return
        }
        for (const key of keys) {
            const metadata = entries[key]
            if (key !== embeddedSnapshotMetadataUtil.key({ name: metadata.name, version: metadata.version })) {
                ctx.addIssue({ code: 'custom', message: formErrors.snapshotMetadataInvalid, path: [key] })
            }
        }
    })
export type EmbeddedSnapshotMetadataMap = z.infer<typeof EmbeddedSnapshotMetadataMap>
