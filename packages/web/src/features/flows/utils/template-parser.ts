import {
  EmbeddedSnapshotMetadataMap,
  ExportedUnresolvedSteps,
  FlowVersionTemplate,
  Template,
} from '@aiqadam/shared';

export const templateUtils = {
  parseTemplate: (jsonString: string): Template | null => {
    try {
      const parsed = JSON.parse(jsonString);
      let template: Template;

      if (
        parsed.flows &&
        Array.isArray(parsed.flows) &&
        parsed.flows.length > 0
      ) {
        template = parsed as Template;
      } else if (parsed.template && parsed.name) {
        template = {
          ...parsed,
          flows: [parsed.template],
        } as Template;
        delete (template as any).template;
      } else {
        return null;
      }

      const { flows, name } = template;
      if (!flows?.[0] || !name || !flows[0].trigger) {
        return null;
      }
      // A file rejected here gets the generic "invalid template" message from every caller; telling
      // the person it was the embedded export metadata would need a result type these callers do
      // not have.
      const checked = flows.map((flow) => withValidExportFields(flow));
      if (checked.some((flow) => flow === null)) {
        return null;
      }

      return { ...template, flows: checked.filter((flow) => flow !== null) };
    } catch {
      return null;
    }
  },

  extractFlow: (jsonString: string): FlowVersionTemplate | null => {
    try {
      const parsed = JSON.parse(jsonString);

      if (
        parsed.flows &&
        Array.isArray(parsed.flows) &&
        parsed.flows.length > 0
      ) {
        return withValidExportFields(parsed.flows[0] as FlowVersionTemplate);
      } else if (parsed.template) {
        return withValidExportFields(parsed.template as FlowVersionTemplate);
      }

      return null;
    } catch {
      return null;
    }
  },
};

// ADR-0004: an export can carry two optional fields a file's author chose, so they are checked
// against the same bounds the server applies before any of the file is used, and the parsed values
// are what the caller gets.
function withValidExportFields<T extends FlowVersionTemplate>(
  flow: T,
): T | null {
  const unresolved = ExportedUnresolvedSteps.optional().safeParse(
    flow.exportedUnresolved,
  );
  const metadata = EmbeddedSnapshotMetadataMap.optional().safeParse(
    flow.snapshotMetadata,
  );
  if (!unresolved.success || !metadata.success) {
    return null;
  }
  return {
    ...flow,
    exportedUnresolved: unresolved.data,
    snapshotMetadata: metadata.data,
  };
}
