import {
  AIProviderConfig,
  AIProviderName,
  AIProviderWithoutSensitiveData,
  isNil,
} from '@aiqadam/shared';

import { AiProviderInfo } from '@/features/agents';

/**
 * Expands the static provider catalogue into the cards the AI settings page renders.
 *
 * Every provider but `custom` is held to one row per platform by a partial unique index, so those
 * keep a single slot per provider *type*. A platform may hold many custom (OpenAI-compatible)
 * rows, so each of those gets a card of its own, keyed and addressed by row id rather than by
 * provider name, followed by one slot that creates another. Custom rows keep the order the server
 * sent them in (`created ASC, id ASC`), so a card does not move between refetches.
 *
 * A stored row whose provider is absent from `providerInfos` is dropped rather than rendered with
 * no logo and no setup instructions.
 */
function buildProviderRows({
  providerInfos,
  providers,
}: BuildProviderRowsParams): AIProviderRow[] {
  return providerInfos.flatMap((providerInfo): AIProviderRow[] => {
    if (providerInfo.provider !== AIProviderName.CUSTOM) {
      const providerConfig = providers.find(
        (candidate) => candidate.provider === providerInfo.provider,
      );
      return [
        {
          key: providerInfo.provider,
          providerInfo,
          providerConfig,
          defaultDisplayName: providerConfig?.name ?? providerInfo.name,
          isCustomCreateSlot: false,
        },
      ];
    }

    const customRows = providers
      .filter((candidate) => candidate.provider === AIProviderName.CUSTOM)
      .map((providerConfig) => ({
        key: providerConfig.id,
        providerInfo,
        providerConfig,
        defaultDisplayName: providerConfig.name,
        isCustomCreateSlot: false,
      }));

    return [
      ...customRows,
      {
        key: CUSTOM_PROVIDER_CREATE_ROW_KEY,
        providerInfo,
        // Each custom row is a card of its own titled by its display name, so seeding a new one
        // with the catalogue label would produce cards nothing tells apart and a chat-provider
        // list of identical entries. The field is visible and required for `custom`, so an empty
        // default asks the operator for a name instead of inventing a duplicate.
        defaultDisplayName: '',
        isCustomCreateSlot: true,
      },
    ];
  });
}

/**
 * Decides whether a card's dialog creates a provider or edits one.
 *
 * The dialog used to infer that from `providerId` being undefined while separately inferring
 * "must an api key be typed" from `config` being undefined — two derivations of one fact, and no
 * way at all to express "create another custom provider while customs already exist". The mode is
 * one explicit tagged value now, so an edit cannot be built without the id of the row it edits.
 */
function buildUpsertTarget({
  providerConfig,
}: BuildUpsertTargetParams): UpsertAIProviderTarget {
  if (isNil(providerConfig)) {
    return { type: 'create' };
  }
  return {
    type: 'edit',
    providerId: providerConfig.id,
    config: providerConfig.config,
  };
}

export const aiProviderRowUtils = { buildProviderRows, buildUpsertTarget };

export const CUSTOM_PROVIDER_CREATE_ROW_KEY = 'custom-create-row';

export type AIProviderRow = {
  key: string;
  providerInfo: AiProviderInfo;
  providerConfig?: AIProviderWithoutSensitiveData;
  defaultDisplayName: string;
  /**
   * The one slot that creates an additional custom provider. It is always rendered, including at
   * the server's `AP_MAX_CUSTOM_AI_PROVIDERS_PER_PLATFORM` ceiling: that ceiling is server-side
   * configuration the browser is never told, so the only honest place to learn a platform is at
   * it is the 403 the create returns, which the dialog renders in the form.
   */
  isCustomCreateSlot: boolean;
};

export type UpsertAIProviderTarget =
  | { type: 'create' }
  | { type: 'edit'; providerId: string; config: AIProviderConfig };

type BuildProviderRowsParams = {
  providerInfos: AiProviderInfo[];
  providers: AIProviderWithoutSensitiveData[];
};

type BuildUpsertTargetParams = {
  providerConfig?: AIProviderWithoutSensitiveData;
};
