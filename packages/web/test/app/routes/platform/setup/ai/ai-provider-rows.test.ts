import {
  AIProviderName,
  AIProviderWithoutSensitiveData,
} from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';

import {
  aiProviderRowUtils,
  CUSTOM_PROVIDER_CREATE_ROW_KEY,
} from '@/app/routes/platform/setup/ai/ai-provider-rows';

function buildProviderInfo({
  provider,
  name,
}: {
  provider: AIProviderName;
  name: string;
}) {
  return {
    provider,
    name,
    markdown: `How to configure ${name}`,
    logoUrl: `/assets/qadams/${provider}.png`,
  };
}

function buildCustomProvider({
  id,
  name,
  baseUrl,
}: {
  id: string;
  name: string;
  baseUrl: string;
}): AIProviderWithoutSensitiveData {
  return {
    id,
    name,
    provider: AIProviderName.CUSTOM,
    config: { apiKeyHeader: 'Authorization', baseUrl, models: [] },
    enabledForChat: false,
  };
}

const PROVIDER_INFOS = [
  buildProviderInfo({ provider: AIProviderName.OPENAI, name: 'OpenAI' }),
  buildProviderInfo({ provider: AIProviderName.ANTHROPIC, name: 'Anthropic' }),
  buildProviderInfo({
    provider: AIProviderName.CUSTOM,
    name: 'Other (OpenAI Compatible)',
  }),
];

const OPENAI_ROW: AIProviderWithoutSensitiveData = {
  id: 'row-openai',
  name: 'OpenAI',
  provider: AIProviderName.OPENAI,
  config: {},
  enabledForChat: true,
};

describe('aiProviderRowUtils.buildProviderRows', () => {
  it('keeps one slot per non-custom provider type and attaches that type’s row', () => {
    const rows = aiProviderRowUtils.buildProviderRows({
      providerInfos: PROVIDER_INFOS,
      providers: [OPENAI_ROW],
    });

    const nonCustomRows = rows.filter(
      (row) => row.providerInfo.provider !== AIProviderName.CUSTOM,
    );
    expect(nonCustomRows.map((row) => row.key)).toEqual([
      AIProviderName.OPENAI,
      AIProviderName.ANTHROPIC,
    ]);
    expect(nonCustomRows[0].providerConfig).toBe(OPENAI_ROW);
    expect(nonCustomRows[1].providerConfig).toBeUndefined();
  });

  it('gives every custom row its own card, keyed by row id, in the order the server sent them', () => {
    const first = buildCustomProvider({
      id: 'row-1',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const second = buildCustomProvider({
      id: 'row-2',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    });

    const rows = aiProviderRowUtils.buildProviderRows({
      providerInfos: PROVIDER_INFOS,
      providers: [first, second],
    });

    const customRows = rows.filter(
      (row) => row.providerInfo.provider === AIProviderName.CUSTOM,
    );
    expect(customRows.map((row) => row.key)).toEqual([
      'row-1',
      'row-2',
      CUSTOM_PROVIDER_CREATE_ROW_KEY,
    ]);
    expect(customRows.map((row) => row.providerConfig)).toEqual([
      first,
      second,
      undefined,
    ]);
    expect(customRows.map((row) => row.defaultDisplayName)).toEqual([
      'DeepSeek',
      'Ollama',
      '',
    ]);
  });

  it('offers exactly one create slot for custom providers whether none exist or the platform is at the server cap', () => {
    const atCap = Array.from({ length: 20 }, (_unused, index) =>
      buildCustomProvider({
        id: `row-${index}`,
        name: `Provider ${index}`,
        baseUrl: `https://provider-${index}.test/v1`,
      }),
    );

    const emptyRows = aiProviderRowUtils.buildProviderRows({
      providerInfos: PROVIDER_INFOS,
      providers: [],
    });
    const atCapRows = aiProviderRowUtils.buildProviderRows({
      providerInfos: PROVIDER_INFOS,
      providers: atCap,
    });

    expect(emptyRows.filter((row) => row.isCustomCreateSlot)).toHaveLength(1);
    expect(atCapRows.filter((row) => row.isCustomCreateSlot)).toHaveLength(1);
    expect(atCapRows).toHaveLength(PROVIDER_INFOS.length - 1 + 20 + 1);
  });

  it('never marks a configured card or a non-custom slot as the custom create slot', () => {
    const rows = aiProviderRowUtils.buildProviderRows({
      providerInfos: PROVIDER_INFOS,
      providers: [
        OPENAI_ROW,
        buildCustomProvider({
          id: 'row-1',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
        }),
      ],
    });

    expect(
      rows
        .filter((row) => row.isCustomCreateSlot)
        .map((row) => row.providerConfig),
    ).toEqual([undefined]);
  });

  it('drops a stored row whose provider is missing from the catalogue', () => {
    const rows = aiProviderRowUtils.buildProviderRows({
      providerInfos: PROVIDER_INFOS,
      providers: [
        {
          id: 'row-bedrock',
          name: 'Bedrock',
          provider: AIProviderName.BEDROCK,
          config: { region: 'us-east-1' },
          enabledForChat: false,
        },
      ],
    });

    expect(rows.some((row) => row.providerConfig?.id === 'row-bedrock')).toBe(
      false,
    );
  });
});

describe('aiProviderRowUtils.buildUpsertTarget', () => {
  it('creates when the card has no row behind it, so a custom provider can be added while others exist', () => {
    expect(
      aiProviderRowUtils.buildUpsertTarget({ providerConfig: undefined }),
    ).toEqual({ type: 'create' });
  });

  it('edits the exact row the card renders rather than the first of its provider type', () => {
    const second = buildCustomProvider({
      id: 'row-2',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    });

    expect(
      aiProviderRowUtils.buildUpsertTarget({ providerConfig: second }),
    ).toEqual({
      type: 'edit',
      providerId: 'row-2',
      config: {
        apiKeyHeader: 'Authorization',
        baseUrl: 'http://localhost:11434/v1',
        models: [],
      },
    });
  });
});
