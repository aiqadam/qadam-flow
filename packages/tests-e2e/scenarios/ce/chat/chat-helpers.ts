import path from 'path';

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * UI plumbing shared by the two chat specs — the stub-driven one and the one that runs against a
 * real third-party endpoint. Kept out of both so the frames each spec produces stay the only thing
 * that differs between them.
 */
export async function createCustomProviderViaUI(
  page: Page,
  provider: CustomAiProvider,
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add Provider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add AI Provider' })).toBeVisible({
    timeout: 10_000,
  });

  await dialog.getByLabel('Display Name').fill(provider.name);
  await dialog.locator('#apiKey').fill(provider.apiKey);
  await dialog.locator('#baseUrl').fill(provider.baseUrl);
  await dialog.locator('#apiKeyHeader').fill('Authorization');

  // An OpenAI-compatible row carries its own model catalogue, so chat resolves a model from the
  // stored config and never asks the provider to list any.
  await dialog.getByRole('button', { name: 'Add Model' }).click();
  const modelPopover = page.locator('[data-slot="popover-content"]');
  await expect(modelPopover.getByRole('heading', { name: 'Add Model' })).toBeVisible({
    timeout: 10_000,
  });
  await modelPopover.locator('#modelId').fill(provider.modelId);
  await modelPopover.locator('#modelName').fill(provider.modelName);
  await modelPopover.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByText(provider.modelId)).toBeVisible({ timeout: 10_000 });

  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/ai-providers' && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await created).status()).toBeLessThan(300);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

// Chat runs on the one row the platform marks `enabledForChat`, chosen from the Chat Provider
// selector at the top of the AI settings page.
export async function selectChatProviderViaUI(page: Page, displayName: string): Promise<void> {
  const selector = page.getByRole('combobox').first();
  await expect(selector).toBeVisible({ timeout: 15_000 });
  await selector.click();
  await page.getByRole('option', { name: displayName }).click();
  await expect(selector).toContainText(displayName, { timeout: 15_000 });
}

export async function deleteProviderViaUI(page: Page, displayName: string): Promise<void> {
  const card = page
    .locator('[data-slot="item"]')
    .filter({ has: page.getByText(displayName, { exact: true }) });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('button:has(svg.lucide-trash)').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete AI Provider' })).toBeVisible({
    timeout: 10_000,
  });
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

export async function openNewChat(page: Page): Promise<void> {
  await page.goto('/chat');
  await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });
}

export async function sendChatMessage(page: Page, text: string): Promise<void> {
  const composer = chatComposer(page);
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  // The user's own bubble is the first thing the send produces, and waiting for it means a later
  // timeout is about the model's reply rather than about a keystroke that never landed.
  await expect(page.getByText(text, { exact: false }).last()).toBeVisible({ timeout: 30_000 });
}

// Tool calls live inside the collapsed activity accordion, and the step's input and output behind
// one more click. That is where "the tool ran" is visible at all.
export async function openLastToolStep(page: Page, label: string): Promise<void> {
  const toggle = page.getByRole('button', { name: /Thought for/ }).last();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  const step = page.getByText(label, { exact: true }).last();
  await expect(step).toBeVisible({ timeout: 15_000 });
  await step.click();
}

/**
 * A frame exists only to prove one milestone behaviour, and its filename says which — hence the
 * caller-supplied `NN-what-it-proves` stem rather than a counter.
 *
 * `animations: 'disabled'` because chat is animation-heavy (collapsibles, motion cards); without it
 * a frame catches a panel mid-expand and shows a grey sliver where the evidence should be.
 */
export async function shot(page: Page, stem: string): Promise<void> {
  await page.screenshot({
    path: path.join(CHAT_SHOTS_DIR, `${stem}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

// The composer's placeholder is 'Ask, build, or run a task...' on an empty conversation and
// 'Reply...' once it has messages, and the bottom bar replaces the composer outright while a
// blocking card (an approval gate) is up.
function chatComposer(page: Page): Locator {
  return page.getByPlaceholder(/Ask, build, or run a task|Reply\.\.\./);
}

export const AI_PROVIDERS_URL = '/platform/setup/ai';

export const CHAT_SHOTS_DIR = path.resolve(__dirname, '../../../screenshots/chat-with-ai');

export type CustomAiProvider = {
  name: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
};
