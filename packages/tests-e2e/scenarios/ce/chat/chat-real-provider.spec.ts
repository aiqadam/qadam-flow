import { test, expect } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, signIn } from '../projects/member-helpers';

import {
  AI_PROVIDERS_URL,
  createCustomProviderViaUI,
  deleteProviderViaUI,
  openNewChat,
  selectChatProviderViaUI,
  sendChatMessage,
  shot,
  type CustomAiProvider,
} from './chat-helpers';

/**
 * #174 against a **real** third-party OpenAI-compatible endpoint.
 *
 * `chat-with-ai.spec.ts` proves the wiring — that the request carries the model id and the
 * credential from the operator's own provider row — by reading a stub's inbox. That is the part a
 * real endpoint cannot show. This spec proves the other part, which a stub cannot: that a genuine
 * vendor, configured by an operator with nothing but a base URL and a key, answers in the app.
 *
 * **The key is never in the repo.** It is read from `E2E_REAL_AI_API_KEY` and the spec skips with a
 * stated reason when that is unset, so the suite still runs for anyone without one. Nothing here
 * screenshots the AI settings page: the `#apiKey` field in the Add AI Provider dialog is a plain
 * text `Input` with no masking (`upsert-provider-config-form.tsx`), so a frame of that dialog would
 * carry the key in the clear. The only frame is of the chat.
 *
 * Defaults describe DeepSeek because that is what this was run against, but nothing is vendor
 * specific — any OpenAI-compatible endpoint works by overriding the two env vars.
 */
test.describe('Chat with AI on a real third-party provider (#174)', () => {
  test.skip(
    process.env.E2E_REAL_AI_API_KEY === undefined,
    'needs a real OpenAI-compatible API key in E2E_REAL_AI_API_KEY (optionally E2E_REAL_AI_BASE_URL / E2E_REAL_AI_MODEL_ID)',
  );
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  // Built in the hook rather than in the describe body: the defaults live at the end of the file
  // per the repo's file-order convention, so reading them during module evaluation is a TDZ error.
  let provider: CustomAiProvider;

  test.beforeAll(async ({ browser }) => {
    provider = realProviderFromEnv();
    const page = await browser.newPage();
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(AI_PROVIDERS_URL);
    await createCustomProviderViaUI(page, provider);
    await selectChatProviderViaUI(page, provider.name);
    await page.close();
  });

  // Deletes the row, and with it the encrypted key, rather than leaving a live credential in the
  // instance the suite was pointed at.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(AI_PROVIDERS_URL);
    await deleteProviderViaUI(page, provider.name);
    await page.close();
  });

  test('streams a real answer from the provider the operator configured (#174)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openNewChat(page);
    // One completion, deliberately: this runs on the operator's own paid account. Asking for a
    // fixed sentence is what makes the answer assertable without pinning anything about the model.
    await sendChatMessage(
      page,
      `Do not use any tools. Reply with exactly this sentence and nothing else: ${MARKER}`,
    );

    // Scoped to the assistant's own bubble, and that is the whole assertion. A bare
    // `getByText(MARKER)` matched the *user's* message — the prompt quotes the sentence it asks for
    // — so it went green in 2 s with the model still thinking. `AssistantMessage` renders
    // `div.py-3.group/msg`; `UserMessage` adds `justify-end`, which is the only structural
    // difference between them.
    const assistantAnswer = page
      .locator('div.py-3:not(.justify-end)')
      .filter({ hasText: MARKER })
      .last();
    await expect(assistantAnswer).toBeVisible({ timeout: 180_000 });
    // The answer must be *text*, not only reasoning: a v4-class reasoning model returns
    // `reasoning_content` alongside `content`, and an answer that landed entirely in the former
    // would render as an empty bubble under a thinking block.
    await expect(page.getByText(/Something went wrong|No output generated/)).toHaveCount(0);
    await shot(page, '01-real-third-party-provider-answers-in-the-app');
  });
});

function realProviderFromEnv(): CustomAiProvider {
  const suffix = Date.now().toString().slice(-6);
  return {
    name: `E2E Real Provider ${suffix}`,
    apiKey: `Bearer ${process.env.E2E_REAL_AI_API_KEY ?? ''}`,
    baseUrl: process.env.E2E_REAL_AI_BASE_URL ?? DEFAULT_REAL_BASE_URL,
    modelId: process.env.E2E_REAL_AI_MODEL_ID ?? DEFAULT_REAL_MODEL_ID,
    modelName: `Real Model ${suffix}`,
  };
}

const DEFAULT_REAL_BASE_URL = 'https://api.deepseek.com/v1';

const DEFAULT_REAL_MODEL_ID = 'deepseek-v4-flash';

const MARKER = 'Qadam Flow chat is answering on the operator own AI provider.';
