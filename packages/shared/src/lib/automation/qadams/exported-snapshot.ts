import { z } from 'zod'
import { BoundedArray, STEP_NAME_REGEX } from '../../core/common'
import { formErrors } from '../../form-errors'
import { VersionType } from './dto/qadam-requests'
import { QADAM_VERSION_MAX_LENGTH, qadamVersionParser } from './qadam-version'

// ADR-0004 "Export and import": the two optional fields an export adds to a flow in a template.
// Both are read by an importer that did not write them, so both are bounded and shaped here, once,
// for every reader (the MCP import, the `IMPORT_FLOW` request, the web importer).
export const EXPORTED_UNRESOLVED_MAX_STEPS = 10_000
export const EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES = 32
export const EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES = 1024 * 1024
const QADAM_NAME_MAX_LENGTH = 214
const STEP_NAME_MAX_LENGTH = 256
// `name@version`.
const SNAPSHOT_KEY_MAX_LENGTH = QADAM_NAME_MAX_LENGTH + 1 + QADAM_VERSION_MAX_LENGTH

export const embeddedSnapshotMetadataUtil = {
    key: ({ name, version }: { name: string, version: string }): string => `${name}@${version}`,
}

// Why an export could not move a snapshot pin to a release. Informational: the importer marks the
// step whichever it is.
export const ExportedUnresolvedReason = z.enum([
    // The release metadata was read and no release passed the props check.
    'no-compatible-release',
    // The snapshot's or a release's metadata could not be read, or the export's fetch budget ran out.
    'metadata-unavailable',
    // The catalogue could not be read at all.
    'catalogue-unavailable',
    // The snapshot's own metadata does not describe the action or trigger the step uses.
    'not-describable',
])
export type ExportedUnresolvedReason = z.infer<typeof ExportedUnresolvedReason>

// A step (or an agent tool of a step) whose snapshot pin the exporting instance could not move to a
// release it could confirm compatible. The importer marks a listed qadam step "update this step".
// `pin` is what the source flow had; for an agent tool `qadamName` is the tool's, not the step's.
export const ExportedUnresolvedStep = z.object({
    stepName: z.string().max(STEP_NAME_MAX_LENGTH).regex(STEP_NAME_REGEX),
    qadamName: z.string().max(QADAM_NAME_MAX_LENGTH),
    pin: VersionType,
    reason: ExportedUnresolvedReason.optional(),
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
    if (new TextEncoder().encode(JSON.stringify(metadata)).length > EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES) {
        ctx.addIssue({ code: 'custom', message: formErrors.snapshotMetadataTooLarge })
    }
})
export type EmbeddedSnapshotMetadata = z.infer<typeof EmbeddedSnapshotMetadata>

// Keyed `name@version`; an entry that names another coordinate than its key is refused, so a key
// can be trusted to say which snapshot the entry describes. The entry count is checked after the
// entries parse, not before: a `z.preprocess` / `.pipe` that checked it first gives the schema an
// input type unlike its output, which the web's template forms (they embed `FlowVersionTemplate`)
// cannot take. Each entry is bounded in bytes and a request body is bounded by the server.
export const EmbeddedSnapshotMetadataMap = z.record(z.string().max(SNAPSHOT_KEY_MAX_LENGTH), EmbeddedSnapshotMetadata)
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
