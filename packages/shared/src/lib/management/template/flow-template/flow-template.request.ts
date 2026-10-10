import { z } from 'zod'
import { OptionalBooleanFromQuery } from '../../../core/common'

export const GetFlowTemplateRequestQuery = z.object({
    versionId: z.string().optional(),
    // ADR-0004 "Export and import": a caller whose template stays on this instance ("create template
    // from flow", the share dialog) sets it, and the snapshot pins are left as they are. Without
    // it the template is an export, and a snapshot pin is rewritten to a release.
    sameInstance: OptionalBooleanFromQuery,
    // An export that keeps snapshot pins, and embeds each one's `metadata.json`, because the person
    // exporting chose to send them to an instance that runs the same snapshots.
    keepSnapshots: OptionalBooleanFromQuery,
})

export type GetFlowTemplateRequestQuery = z.infer<typeof GetFlowTemplateRequestQuery>
