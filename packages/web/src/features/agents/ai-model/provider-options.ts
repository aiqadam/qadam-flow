import {
  AIProviderConfig,
  AIProviderName,
  AIProviderWithoutSensitiveData,
  isNil,
  OpenAICompatibleProviderConfig,
} from '@aiqadam/shared';

import { SUPPORTED_AI_PROVIDERS } from '@/features/agents/ai-providers';

/**
 * Expands the platform's provider rows into the entries the model picker offers.
 *
 * One entry per **row**, not per provider *type*: a platform may hold several custom
 * (OpenAI-compatible) rows, and a step addresses one of them by id. Rows keep the order the server
 * sent them in (`created ASC, id ASC`), so an entry does not move between refetches.
 *
 * Two rows may carry the same `displayName` — nothing enforces uniqueness on it — so the name
 * alone cannot identify an entry. The row's base url is what actually differs between two
 * OpenAI-compatible endpoints, it is already on the client, and it is the value the operator typed,
 * so it is what the entry shows underneath the name and what search matches on. The row id would
 * also be unique, but 21 opaque characters tell the person choosing nothing about which endpoint
 * they are choosing.
 */
function build({ providers }: BuildParams): AIProviderOption[] {
  return providers.map((provider): AIProviderOption => {
    const baseUrl = readBaseUrl({ config: provider.config });
    return {
      id: provider.id,
      provider: provider.provider,
      name: provider.name,
      baseUrl,
      logoUrl: SUPPORTED_AI_PROVIDERS.find(
        (candidate) => candidate.provider === provider.provider,
      )?.logoUrl,
      searchKeywords: isNil(baseUrl)
        ? [provider.name]
        : [provider.name, baseUrl],
    };
  });
}

/**
 * Picks the entry a stored `aiProviderModel` points at, by the same rule the server resolves a
 * provider ref with (`findProviderOrThrow`): the row id first, then the provider name, which
 * answers with the platform's oldest row of that type.
 *
 * Mirroring the server matters because the picker is a claim about what the step will run against.
 * Two cases it deliberately does **not** collapse:
 *
 * - A stored ref that resolves to nothing (a deleted row, a provider type that is no longer
 *   configured) leaves the picker empty rather than falling back to some other row. Falling back
 *   would look harmless and then rewrite the step to a provider the operator never chose, because
 *   the catalogue effect emits whatever is selected.
 * - Auto-selecting the first row happens only when the step stores no provider reference at all,
 *   which is a step that has just been added.
 */
function resolveSelected({
  options,
  selectedProviderId,
  defaultProviderId,
  defaultProvider,
}: ResolveSelectedParams): AIProviderOption | undefined {
  const pinnedId = selectedProviderId ?? defaultProviderId;
  if (!isNil(pinnedId)) {
    const pinned = options.find((option) => option.id === pinnedId);
    if (!isNil(pinned)) {
      return pinned;
    }
  }
  if (!isNil(defaultProvider)) {
    return options.find((option) => option.provider === defaultProvider);
  }
  return options[0];
}

function readBaseUrl({
  config,
}: {
  config: AIProviderConfig;
}): string | undefined {
  const parsed = OpenAICompatibleProviderConfig.safeParse(config);
  return parsed.success ? parsed.data.baseUrl : undefined;
}

export const aiProviderOptions = { build, resolveSelected };

export type AIProviderOption = {
  id: string;
  provider: AIProviderName;
  name: string;
  baseUrl?: string;
  logoUrl?: string;
  searchKeywords: string[];
};

type BuildParams = {
  providers: AIProviderWithoutSensitiveData[];
};

type ResolveSelectedParams = {
  options: AIProviderOption[];
  selectedProviderId?: string;
  defaultProviderId?: string;
  defaultProvider?: AIProviderName;
};
