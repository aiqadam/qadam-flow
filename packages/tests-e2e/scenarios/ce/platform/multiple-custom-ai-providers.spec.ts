import path from 'path';

import { test, expect, type Locator, type Page } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, signIn } from '../projects/member-helpers';

const SHOTS = path.resolve(
  __dirname,
  '../../../screenshots/multiple-custom-ai-providers',
);

const AI_PROVIDERS_URL = '/platform/setup/ai';

// #98: a platform admin configures TWO custom (OpenAI-compatible) providers and addresses them
// independently from a Run Agent step — the two clauses of the issue's Expected, driven entirely
// through the UI with a screenshot at every step.
//
// Every assertion here is keyed on something that tells the two rows apart. Display names are not
// unique in this feature (nothing enforces uniqueness on them), so the spec asserts on each row's
// BASE URL — the value that actually differs between two OpenAI-compatible endpoints and the one
// the picker renders under the name. Asserting on a name alone would pass against a build that
// still collapses both rows into one, which is exactly the regression this scenario exists to
// catch.
//
// What each step covers, and what it looked like before the feature landed:
//   2 — a second custom row. The settings page used to render one card per provider *type*, so
//       there was no create-another slot to click and `POST /v1/ai-providers` answered 500 on the
//       total unique index (#274, #279). Run against a pre-feature image this spec fails right
//       here, on `Add Provider` never appearing — the page offers a single "Enable".
//   3 — the model picker offering one entry per row rather than one per provider type (#285).
//   4 — the step's pin surviving a reopen, as the row it was set to (#280, #282).
//   5 — a pin whose row has been deleted reporting itself unresolved instead of quietly resolving
//       to a sibling custom row (#285). That substitution was invisible, which is why this is the
//       step most worth an artifact.
test.describe('Multiple custom AI providers, addressed independently (#98, UI)', () => {
  test.setTimeout(240_000);

  test('admin configures two custom providers, pins a Run Agent step to the second, and sees the pin go unresolved once that row is deleted', async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const first: CustomProvider = {
      name: `E2E Alpha ${suffix}`,
      baseUrl: `https://alpha-${suffix}.e2e.invalid/v1`,
      apiKey: 'Bearer sk-e2e-fake-alpha',
      modelId: `alpha-model-${suffix}`,
      modelName: `Alpha Model ${suffix}`,
    };
    const second: CustomProvider = {
      name: `E2E Beta ${suffix}`,
      baseUrl: `https://beta-${suffix}.e2e.invalid/v1`,
      apiKey: 'Bearer sk-e2e-fake-beta',
      modelId: `beta-model-${suffix}`,
      modelName: `Beta Model ${suffix}`,
    };

    let step = 0;
    const shot = async (p: Page, name: string) => {
      step += 1;
      await p.screenshot({
        path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`,
        fullPage: true,
      });
    };

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // ---- 1. First custom provider ------------------------------------------------------------
    await page.goto(AI_PROVIDERS_URL);
    await expect(
      page.getByRole('heading', { name: 'AI Providers' }),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, 'ai-providers-settings-page');

    await createCustomProviderViaUI(page, first);
    await expect(providerCard(page, first.name)).toBeVisible({ timeout: 10_000 });
    await shot(page, 'first-custom-provider-created');

    // ---- 2. Second custom provider — impossible before #274/#279 -----------------------------
    await createCustomProviderViaUI(page, second);
    await expect(providerCard(page, second.name)).toBeVisible({ timeout: 10_000 });

    // Two distinct cards, plus the slot that creates another. `toHaveCount(2)` is on cards
    // carrying this run's suffix, so a leftover custom row from another run cannot inflate it.
    await expect(
      page.locator('[data-slot="item"]').filter({ hasText: 'E2E ' }).filter({ hasText: suffix }),
    ).toHaveCount(2);
    await expect(providerCard(page, first.name)).toBeVisible();
    await expect(providerCard(page, second.name)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Provider' })).toBeVisible();
    await shot(page, 'two-custom-cards-plus-add-slot');

    // ---- 3. Run Agent step: the picker offers one entry per ROW ------------------------------
    const builderUrl = await createFlowWithRunAgentStepViaUI(page);
    await shot(page, 'run-agent-step-opened');

    const aiModel = aiModelSection(page);
    await aiModel.getByRole('combobox').first().click();

    const firstOption = page.getByRole('option').filter({ hasText: first.baseUrl });
    const secondOption = page.getByRole('option').filter({ hasText: second.baseUrl });
    await expect(firstOption).toHaveCount(1);
    await expect(secondOption).toHaveCount(1);
    // Distinct entries, not one entry matched twice: cmdk keys and selects on the row id, so the
    // two must carry different `data-value`s. Before #285 both rows produced the value `custom`.
    const firstValue = await firstOption.getAttribute('data-value');
    const secondValue = await secondOption.getAttribute('data-value');
    expect(firstValue).toBeTruthy();
    expect(secondValue).toBeTruthy();
    expect(firstValue).not.toBe(secondValue);
    await expect(firstOption).toContainText(first.name);
    await expect(secondOption).toContainText(second.name);
    await shot(page, 'picker-shows-two-separately-selectable-rows');

    // ---- 4. Select the SECOND row, save, reopen, and check which row came back ---------------
    const flowSaved = waitForFlowSave(page);
    await secondOption.click();
    await expect(aiModel.getByRole('combobox').first()).toContainText(second.baseUrl);
    await selectModelViaUI(page, second.modelName);
    await flowSaved;
    await shot(page, 'second-provider-selected');

    await page.goto(builderUrl);
    await openRunAgentStepViaUI(page);
    const reopened = aiModelSection(page).getByRole('combobox').first();
    await expect(reopened).toContainText(second.baseUrl, { timeout: 20_000 });
    await expect(reopened).toContainText(second.name);
    // The pin is the SECOND row, not the platform's oldest custom row.
    await expect(reopened).not.toContainText(first.baseUrl);
    await expect(reopened).not.toContainText(first.name);
    await expect(aiModelSection(page).getByRole('combobox').nth(1)).toContainText(
      second.modelName,
    );
    await shot(page, 'pin-persisted-as-second-row-after-reopen');

    // ---- 5. Delete the pinned row — the step must say so, not substitute a sibling -----------
    await page.goto(AI_PROVIDERS_URL);
    await deleteProviderViaUI(page, second.name);
    await expect(providerCard(page, second.name)).toHaveCount(0);
    await expect(providerCard(page, first.name)).toBeVisible();
    await shot(page, 'second-provider-deleted');

    await page.goto(builderUrl);
    await openRunAgentStepViaUI(page);
    const unresolved = aiModelSection(page);
    await expect(unresolved.getByTestId('ai-provider-unresolved-ref')).toBeVisible({
      timeout: 20_000,
    });
    await expect(unresolved.getByRole('combobox').first()).toContainText(
      'Provider no longer available',
    );
    // The surviving row must NOT have been quietly substituted for the deleted one.
    await expect(unresolved.getByRole('combobox').first()).not.toContainText(first.baseUrl);
    await expect(unresolved.getByRole('combobox').first()).not.toContainText(first.name);
    await shot(page, 'picker-reports-unresolved-provider');

    // Leave the platform as the spec found it — the row cap
    // (`AP_MAX_CUSTOM_AI_PROVIDERS_PER_PLATFORM`, default 20) is per platform and this suite is
    // run repeatedly against the same instance.
    await page.goto(AI_PROVIDERS_URL);
    await deleteProviderViaUI(page, first.name);
  });
});

// The AI Model selector's own wrapper — the two comboboxes (provider, model) and the unresolved-ref
// message all live under it, and the step settings panel holds other comboboxes that must not be
// confused with them.
function aiModelSection(page: Page): Locator {
  return page.getByRole('heading', { name: 'AI Model *' }).locator('xpath=..');
}

function providerCard(page: Page, displayName: string): Locator {
  return page
    .locator('[data-slot="item"]')
    .filter({ has: page.getByText(displayName, { exact: true }) });
}

// Waits for the builder's own autosave of the step, so a navigation cannot race it.
function waitForFlowSave(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (r) =>
      /\/api\/v1\/flows\/[^/?]+$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST' &&
      r.status() < 300,
    { timeout: 30_000 },
  );
}

async function createCustomProviderViaUI(page: Page, provider: CustomProvider): Promise<void> {
  await page.getByRole('button', { name: 'Add Provider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add AI Provider' })).toBeVisible({
    timeout: 10_000,
  });

  await dialog.getByLabel('Display Name').fill(provider.name);
  await dialog.locator('#apiKey').fill(provider.apiKey);
  await dialog.locator('#baseUrl').fill(provider.baseUrl);
  await dialog.locator('#apiKeyHeader').fill('Authorization');

  // An OpenAI-compatible row carries its own model catalogue; the server never fetches one.
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
    (r) =>
      new URL(r.url()).pathname === '/api/v1/ai-providers' &&
      r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await created).status()).toBeLessThan(300);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

async function deleteProviderViaUI(page: Page, displayName: string): Promise<void> {
  const card = providerCard(page, displayName);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('button:has(svg.lucide-trash)').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete AI Provider' })).toBeVisible({
    timeout: 10_000,
  });
  const deleted = page.waitForResponse(
    (r) =>
      /\/api\/v1\/ai-providers\/[^/?]+$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'DELETE',
    { timeout: 30_000 },
  );
  await dialog.getByRole('button', { name: 'Remove' }).click();
  expect((await deleted).status()).toBeLessThan(300);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

// Creates a flow from scratch, gives it a trigger (the builder needs one before an action can be
// added) and appends the Run Agent step. Returns the builder URL so the step can be reopened.
async function createFlowWithRunAgentStepViaUI(page: Page): Promise<string> {
  await page.goto('/automations');
  const createNew = page.getByRole('button', { name: 'Create New' });
  const fromScratch = page.getByRole('button', { name: 'Start from scratch' }).first();
  await expect(createNew.or(fromScratch).first()).toBeVisible({ timeout: 30_000 });
  if (await createNew.isVisible()) {
    await createNew.click();
    await page.getByRole('menuitem', { name: 'New Flow' }).click();
  } else {
    await fromScratch.click();
  }
  await page.waitForURL('**/flows/**', { timeout: 30_000 });
  await page.waitForSelector('.react-flow__node', { state: 'visible' });

  await page.getByTestId('rf__node-trigger').filter({ hasText: 'Select Trigger' }).click();
  await page.getByTestId('qadams-search-input').fill('Catch Webhook');
  await page.getByText('Catch Webhook').click();

  await page.getByTestId('add-action-button').click();
  await page.getByTestId('qadams-search-input').fill('Run Agent');
  await page.getByTestId('AI').click();
  await page.getByText('Run Agent', { exact: true }).last().click();

  await expect(page.getByRole('heading', { name: 'AI Model *' })).toBeVisible({
    timeout: 30_000,
  });
  return page.url();
}

async function openRunAgentStepViaUI(page: Page): Promise<void> {
  await page.waitForSelector('.react-flow__node', { state: 'visible' });
  await page.locator('.react-flow__node').filter({ hasText: 'Run Agent' }).first().click();
  await expect(page.getByRole('heading', { name: 'AI Model *' })).toBeVisible({
    timeout: 30_000,
  });
}

async function selectModelViaUI(page: Page, modelName: string): Promise<void> {
  const modelTrigger = aiModelSection(page).getByRole('combobox').nth(1);
  await expect(modelTrigger).toBeEnabled({ timeout: 20_000 });
  await modelTrigger.click();
  await page.getByRole('option').filter({ hasText: modelName }).click();
  await expect(modelTrigger).toContainText(modelName);
}

type CustomProvider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelName: string;
};
