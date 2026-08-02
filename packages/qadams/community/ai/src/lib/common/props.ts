import { QadamAuth, Property } from '@aiqadam/qadams-framework';
import { httpClient, HttpMethod } from '@aiqadam/qadams-common';
import {
  isNil,
  AIProviderModel,
  AIProviderWithoutSensitiveData,
  OpenAICompatibleProviderConfig,
} from '@aiqadam/shared';
import { resolveProviderRef } from './ai-sdk';

export const aiProps = <T extends AIModelType>({ modelType }: AIPropsParams<T>) => ({
  // Keeps emitting the provider *name*. That is what every stored step already holds, and what the
  // capability checks read — `web-search.ts`, the OpenAI responses-API switch, the AI-SDK
  // `providerOptions` namespace key and `getEffectiveProviderAndModel` all key on the enum and none
  // of them can consume a row id.
  //
  // What changed is that it offers one entry per provider *type* rather than one per row. A
  // platform can hold several custom rows, and one entry per row put two identically-valued options
  // in the list: `searchable-select` keys options by index so both were clickable, resolves the
  // trigger label by value equality so the second rendered as the first, and the server resolves a
  // bare name to the platform's oldest row of that type. Picking the second one looked like it
  // worked and ran the first, with no error anywhere. Choosing *which row* is `providerId`'s job.
  provider: Property.Dropdown<string, true>({
    auth: QadamAuth.None(),
    displayName: 'Provider',
    required: true,
    refreshers: [],
    options: async (_, ctx) => {
      const rows = await listProviderRows(ctx);

      return {
        placeholder: 'Select AI Provider',
        disabled: false,
        options: firstRowPerProviderType(rows).map((row) => ({
          label: row.name,
          value: row.provider,
        })),
      };
    },
  }),

  // Optional, deliberately. `flow-version-validator-util` builds a zod schema from an action's
  // props and parses the stored input against it, projecting in every schema key the input does not
  // carry as `undefined` — so a required prop marks every step saved before this change invalid the
  // next time it is validated, over a field its author never had the chance to fill. Absent already
  // means exactly what those steps depend on: `resolveProviderRef` sends the provider name and the
  // server answers with the platform's oldest row of that type, so a step written before this prop
  // existed keeps running against precisely the row it runs against today.
  providerId: Property.Dropdown<string, false>({
    auth: QadamAuth.None(),
    displayName: 'Provider Configuration',
    description:
      'Which of the configured providers to run against. Only needed when the platform holds more than one configuration of the selected provider.',
    required: false,
    refreshers: ['provider'],
    options: async (propsValue, ctx) => {
      const provider = readNonEmptyString(propsValue['provider']);
      if (isNil(provider)) {
        return {
          disabled: true,
          options: [],
          placeholder: 'Select AI Provider',
        };
      }

      const rows = (await listProviderRows(ctx)).filter(
        (row) => row.provider === provider
      );
      if (rows.length === 0) {
        return {
          disabled: true,
          options: [],
          placeholder: 'Select AI Provider',
        };
      }

      // Which row answers when nothing is picked is marked on that row, not stated in the
      // placeholder. The builder's generic dropdown renders `placeholder` both when the field is
      // unset and when the stored value matches no option — a row deleted out from under the step —
      // so a placeholder promising a fallback would assert it hardest in the one case where the
      // step is instead heading for `ENTITY_NOT_FOUND`. On the row the claim is unconditional.
      return {
        placeholder: 'Select a provider configuration',
        disabled: false,
        options: rows.map((row, index) => ({
          label: index === 0 ? `${buildRowLabel({ row, rows })} (default)` : buildRowLabel({ row, rows }),
          value: row.id,
        })),
      };
    },
  }),

  model: Property.Dropdown({
    auth: QadamAuth.None(),
    displayName: 'Model',
    required: true,
    // `providerId` belongs here for the same reason `provider` does: two rows of one type serve
    // different catalogues, so a list left over from the previous row offers models the chosen
    // endpoint does not have.
    refreshers: ['provider', 'providerId'],
    options: async (propsValue, ctx) => {
      const provider = readNonEmptyString(propsValue['provider']);

      if (isNil(provider)) {
        return {
          disabled: true,
          options: [],
          placeholder: 'Select AI Provider',
        };
      }

      // The same single entry point both model resolvers use, so the catalogue the builder shows
      // comes from the row the step will actually run against.
      const providerRef = resolveProviderRef({
        providerId: readNonEmptyString(propsValue['providerId']),
        provider,
      });

      const { body: allModels } =
        await httpClient.sendRequest<AIProviderModel[]>({
          method: HttpMethod.GET,
          url: `${ctx.server.apiUrl}v1/ai-providers/${encodeURIComponent(providerRef)}/models`,
          headers: {
            Authorization: `Bearer ${ctx.server.token}`,
          },
        });

      return {
        placeholder: 'Select AI Model',
        disabled: false,
        options: allModels.filter(model => model.type === modelType).map(model => ({
          label: model.name,
          value: model.id,
        })),
      };
    },
  }),
});

async function listProviderRows(ctx: PropsServerContext): Promise<AIProviderWithoutSensitiveData[]> {
  const { body } = await httpClient.sendRequest<AIProviderWithoutSensitiveData[]>({
    method: HttpMethod.GET,
    url: `${ctx.server.apiUrl}v1/ai-providers`,
    headers: {
      Authorization: `Bearer ${ctx.server.token}`,
    },
  });
  return body;
}

// The server returns rows in `created ASC, id ASC` — the order `findProviderOrThrow` uses to decide
// which row a bare provider name addresses — so keeping the first of each type makes the label the
// dropdown shows the row that choice actually reaches.
function firstRowPerProviderType(rows: AIProviderWithoutSensitiveData[]): AIProviderWithoutSensitiveData[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.provider)) {
      return false;
    }
    seen.add(row.provider);
    return true;
  });
}

// Nothing enforces uniqueness on `displayName`, so the name alone cannot identify a row. The base
// url is what actually differs between two OpenAI-compatible endpoints and is the value the
// operator typed, which is why the builder's model picker disambiguates on it too.
//
// Two more collisions are reachable and neither may leave two identical labels: a config blanked by
// a partial update before #272 has no url at all, and nothing stops two rows sharing both a name
// and a base url. Each step is tried in turn and the row id — opaque, but unique by construction —
// is the floor.
function buildRowLabel({ row, rows }: { row: AIProviderWithoutSensitiveData, rows: AIProviderWithoutSensitiveData[] }): string {
  const others = rows.filter((other) => other.id !== row.id);
  const distinct = shareableLabels(row).find((candidate) =>
    !others.some((other) => shareableLabels(other).includes(candidate))
  );
  return distinct ?? `${row.name} (${row.id})`;
}

// The forms two rows can end up sharing, shortest first. The id form is deliberately not among
// them: it is the floor `buildRowLabel` falls to precisely because it cannot collide.
function shareableLabels(row: AIProviderWithoutSensitiveData): string[] {
  const parsed = OpenAICompatibleProviderConfig.safeParse(row.config);
  return parsed.success ? [row.name, `${row.name} (${parsed.data.baseUrl})`] : [row.name];
}

// A dropdown with no selection and an MCP agent filling every advertised key both write `''`.
// `resolveProviderRef` would reject that, so this is not what keeps a malformed ref out of a URL —
// it is what turns "nothing chosen yet" into a disabled dropdown instead of an exception rendered
// by `DynamicPropertiesErrorBoundary`.
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

type AIModelType = 'text' | 'image';

type AIPropsParams<T extends AIModelType> = {
  modelType: T;
};

type PropsServerContext = {
  server: {
    apiUrl: string;
    token: string;
  };
};
