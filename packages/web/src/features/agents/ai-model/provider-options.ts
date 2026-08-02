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
 * Picks the entry a stored `aiProviderModel` points at, by the rule that decides what the step will
 * actually run against. That rule lives in two places and neither is a fallback chain:
 *
 * - `resolveProviderRef` (`qadams/community/ai/src/lib/common/ai-sdk.ts`) turns the step's input
 *   into **one** ref — `providerId` when it is present and non-empty, otherwise the provider name.
 *   Precedence, chosen before the request is made.
 * - `findProviderOrThrow` (`server/api/src/app/ai/ai-provider-service.ts`) receives that single ref
 *   and dispatches on its *shape*: a name reads the platform's oldest row of that type
 *   (`created ASC, id ASC`), an id reads that row. Neither branch falls through to the other, and a
 *   ref matching no row raises `ENTITY_NOT_FOUND`.
 *
 * So there is no server path that retries a dead id as a name, and this must not invent one. Two
 * cases it deliberately does **not** collapse:
 *
 * - A ref that resolves to nothing — a deleted row, or a provider type no longer configured —
 *   resolves to nothing here too, rather than falling back to a sibling row. The fallback is the
 *   dangerous branch, not the empty one: `provider` is non-optional on a stored value, so a
 *   deleted custom row still names a type some other custom row matches, and the catalogue effect
 *   emits whatever is selected. Merely opening the step would then rewrite it to an endpoint the
 *   operator never chose, on no gesture at all — a run-time `ENTITY_NOT_FOUND` traded for prompts
 *   quietly sent somewhere else. `unresolvedRef` is how the picker says so out loud instead.
 * - Auto-selecting the first row happens only when the step stores no provider reference at all,
 *   which is a step that has just been added.
 */
function resolveSelected({
  options,
  selectedProviderId,
  defaultProviderId,
  defaultProvider,
}: ResolveSelectedParams): ResolvedProvider {
  const pinnedId = selectedProviderId ?? defaultProviderId;
  if (!isNil(pinnedId)) {
    return asResolved(options.find((option) => option.id === pinnedId));
  }
  if (!isNil(defaultProvider)) {
    return asResolved(
      options.find((option) => option.provider === defaultProvider),
    );
  }
  return { option: options[0], unresolvedRef: false };
}

function asResolved(option: AIProviderOption | undefined): ResolvedProvider {
  return { option, unresolvedRef: isNil(option) };
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

/**
 * `unresolvedRef` distinguishes the two ways `option` can be absent, which look identical in the
 * trigger otherwise: a step that has chosen nothing yet, and a step whose choice has been deleted
 * out from under it. Only the second is a fault the operator has to act on.
 */
type ResolvedProvider = {
  option?: AIProviderOption;
  unresolvedRef: boolean;
};
