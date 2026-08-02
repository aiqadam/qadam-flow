import { test, expect, type Page } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, signIn } from '../projects/member-helpers';

import {
  AI_PROVIDERS_URL,
  createCustomProviderViaUI,
  deleteProviderViaUI,
  openLastToolStep,
  openNewChat,
  selectChatProviderViaUI,
  sendChatMessage,
  shot,
} from './chat-helpers';
import {
  delayedTextStream,
  flowIdFromTranscript,
  replayedToolArguments,
  startOpenAiStub,
  STUB_MODEL_ID,
  textStream,
  toolCallsStream,
  toolCallStream,
  toolResultText,
  type OpenAiStub,
} from './openai-stub';

/**
 * Chat with AI, driven end to end against a scripted provider — the three chat behaviours in v2.0.0
 * that shipped with no visual evidence, plus the wiring assertion for the fourth.
 *
 * **Why a stub.** Chat runs on whatever the operator configured, and the CUSTOM (OpenAI-compatible)
 * provider type takes any `baseUrl`. So the spec stands up a small OpenAI-compatible server inside
 * the Playwright worker (`openai-stub.ts`), points a CUSTOM provider at it through the platform AI
 * settings UI, and drives the chat from the browser. Nothing leaves the machine and every turn is
 * scripted — which is the only way to reach the three *small local model* behaviours below on
 * demand. A real hosted model does not withhold its first token or stringify a number when asked
 * to, so a test that waited for one to misbehave would be flaky by construction.
 *
 * `chat-real-provider.spec.ts` is the other half: the same feature against a genuine third-party
 * OpenAI-compatible endpoint, which is the stronger evidence for #174 specifically.
 *
 * What each test covers:
 *   #174 — the request reached the operator's row: the stub sees the model id from that row's
 *          catalogue and the credential header the operator typed. No frame here; the #174 frame
 *          comes from the real-provider spec, where a stub would prove less.
 *   #264 — a destructive tool (`ap_delete_flow`) stops at an approval card. Denied, the flow is
 *          still there; approved, only that flow is gone. `ap_create_flow` in the same conversation
 *          is the control: ungated, so it runs on the model's word alone.
 *   #267 — a tool call whose numeric argument arrives as the JSON string `"5"` still runs, and the
 *          server replays it to the model as the number `5`. Pre-#268 this was
 *          `expected number, received string` and the model then leaked a raw tool call as prose.
 *   #265 — a model that sends nothing for longer than the *inter-chunk* idle bound still completes,
 *          because #266 gave the first byte its own, much larger deadline.
 *   #289 — and the answer appears in the tab that asked, because the browser now takes both bounds
 *          from the server instead of enforcing a flat two minutes of its own.
 *
 * **Requires a stack the SSRF filter lets reach the stub.** Provider calls go through
 * `safeHttp.fetch`, which rejects private and loopback addresses, so the instance under test must
 * run with `AP_SSRF_ALLOW_LIST` covering the Docker gateway (e.g. `172.16.0.0/12`). The bundled
 * `docker-compose.yml` does not set it, so the CI e2e job cannot run this spec — it is skipped
 * unless `E2E_CHAT_STUB_HOST` names the address the server should call back on
 * (`host.docker.internal` for a Docker stack reached from the host network).
 */
test.describe('Chat with AI on a scripted operator-configured provider (#174, #264, #265, #267, #289)', () => {
  test.skip(
    process.env.E2E_CHAT_STUB_HOST === undefined,
    'needs a stack booted with AP_SSRF_ALLOW_LIST so the server can reach the local OpenAI stub; set E2E_CHAT_STUB_HOST to the address it should call back on',
  );
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  const suffix = Date.now().toString().slice(-6);
  const provider = {
    name: `E2E Chat Stub ${suffix}`,
    apiKey: `Bearer sk-e2e-chat-${suffix}`,
    modelId: STUB_MODEL_ID,
    modelName: `Stub Model ${suffix}`,
  };

  let stub: OpenAiStub;

  test.beforeAll(async ({ browser }) => {
    stub = await startOpenAiStub();
    const page = await browser.newPage();
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(AI_PROVIDERS_URL);
    await createCustomProviderViaUI(page, { ...provider, baseUrl: stub.baseUrl });
    await selectChatProviderViaUI(page, provider.name);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(AI_PROVIDERS_URL);
    await deleteProviderViaUI(page, provider.name);
    await page.close();
    await stub.stop();
  });

  test.beforeEach(() => {
    stub.reset();
  });

  // #174. The wiring, asserted rather than photographed: the model id and the credential header the
  // provider was reached with both came out of the row the operator created, and there is no
  // build-time key anywhere in the path. A real endpoint cannot show this — only a server whose
  // inbox the test can read can.
  test('reaches the AI provider row the operator configured, with that row own model and credential (#174)', async ({
    page,
  }) => {
    const answer = `Hello. I am answering through ${provider.name}, model ${STUB_MODEL_ID}.`;
    stub.script([textStream(answer)]);

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openNewChat(page);
    await sendChatMessage(page, 'Say hello and name the provider you are running on.');

    await expect(page.getByText(answer)).toBeVisible({ timeout: 90_000 });

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].path).toBe('/v1/chat/completions');
    expect(stub.requests[0].body['model']).toBe(STUB_MODEL_ID);
    expect(stub.requests[0].authorization).toBe(provider.apiKey);
  });

  // #264. The gate, both ways, with the flow list as the ground truth rather than the model's word
  // for it. Two flows are created, not one: the bystander is what makes the "after" frame legible —
  // an empty list would prove only that something disappeared — and it also shows that answering one
  // gate did not spend another.
  test('stops a destructive tool at an approval prompt, and runs it only when approved (#264)', async ({
    page,
  }) => {
    const victim = `E2E Gate Victim ${suffix}`;
    const bystander = `E2E Gate Bystander ${suffix}`;

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openNewChat(page);

    // --- The ungated control: draft-only flow edits run on the model's word alone ---------------
    stub.script([
      toolCallsStream([
        { toolName: 'ap_create_flow', callId: 'call_create_1', args: JSON.stringify({ flowName: victim }) },
        { toolName: 'ap_create_flow', callId: 'call_create_2', args: JSON.stringify({ flowName: bystander }) },
      ]),
      textStream('Created both.'),
    ]);
    await sendChatMessage(page, `Create two flows: ${victim} and ${bystander}.`);
    await expect(page.getByText('Created both.')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('tool-approval-card')).toBeHidden();

    // --- The gated call: it must stop, and the card must show what it would run with ------------
    stub.reset();
    // The id comes out of the receipt `ap_create_flow` just wrote into the transcript, so the spec
    // never reaches past the UI to mint a flow of its own.
    stub.script([
      (request) =>
        toolCallStream({
          toolName: 'ap_delete_flow',
          callId: 'call_delete_denied',
          args: JSON.stringify({ flowId: flowIdFromTranscript({ request, displayName: victim }) }),
        }),
      textStream('Understood — I left the flow alone.'),
    ]);
    await sendChatMessage(page, `Now delete ${victim}.`);

    const card = page.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card.getByText('ap_delete_flow')).toBeVisible();
    // The arguments are the security control, not decoration: a card that named no flow would ask
    // the user to authorise something they cannot see.
    await expect(card.getByTestId('tool-approval-input')).toContainText('flowId');
    await shot(page, '02-approval-prompt-before-a-destructive-tool');

    // Read the flow the card is offering to delete straight off the card, so the approved half
    // below is provably the *same* call rather than a second one the spec composed for itself.
    const gatedFlowId = (await card.locator('dd').first().innerText()).trim();
    expect(gatedFlowId).toMatch(/^[0-9a-zA-Z]{21}$/);

    // --- Denied ---------------------------------------------------------------------------------
    await card.getByTestId('tool-approval-deny').click();
    await expect(page.getByText('Understood — I left the flow alone.')).toBeVisible({
      timeout: 90_000,
    });
    // The model's own sentence is not the evidence, and the transcript cannot supply any: an
    // answered gate is persisted as `approval-responded` with no output either way, because the SDK
    // runs an approved call before the resumed run's first round-trip, outside any recorded step
    // (see the comment on that state in `chat-utils.ts`). Approved and denied therefore look the
    // same in the chat. The flow list is the only thing that tells them apart, so it is the frame.
    await openAutomationsFilteredBy(page, suffix);
    await expect(page.getByText(victim)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(bystander)).toBeVisible();
    await shot(page, '03-denied-gate-left-the-flow-in-place');

    // --- Approved, same tool and the same flow --------------------------------------------------
    stub.reset();
    stub.script([
      toolCallStream({
        toolName: 'ap_delete_flow',
        callId: 'call_delete_approved',
        args: JSON.stringify({ flowId: gatedFlowId }),
      }),
      textStream('Done — the flow is gone.'),
    ]);
    await openNewChat(page);
    await sendChatMessage(page, `Delete the flow ${victim}.`);

    const secondCard = page.getByTestId('tool-approval-card');
    await expect(secondCard).toBeVisible({ timeout: 90_000 });
    await secondCard.getByTestId('tool-approval-approve').click();
    await expect(page.getByText('Done — the flow is gone.')).toBeVisible({ timeout: 90_000 });

    await openAutomationsFilteredBy(page, suffix);
    // Exactly the flow the gate named, and only that one.
    await expect(page.getByText(bystander)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(victim)).toHaveCount(0);
    await shot(page, '04-approved-gate-deleted-only-the-flow-it-named');

    // Leave the instance as the spec found it; this suite is run repeatedly against the same one.
    await deleteFlowViaUI(page, bystander);
  });

  // #267. `llama3.1:8b` sends every tool argument as a string, so `{"limit":"5"}` used to be
  // rejected as `expected number, received string` and the model recovered by printing a raw tool
  // call into the user-visible answer. The frame is the expanded activity row: the argument the
  // tool actually ran with, and the result it produced.
  test('runs a tool whose numeric argument the model sent as a string (#267)', async ({ page }) => {
    const answer = 'You have no flows yet.';
    stub.script([
      toolCallStream({ toolName: 'ap_list_flows', callId: 'call_string_limit', args: '{"limit":"5"}' }),
      textStream(answer),
    ]);

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openNewChat(page);
    await sendChatMessage(page, 'List my flows. (The stub model will send limit as the string "5".)');

    await expect(page.getByText(answer)).toBeVisible({ timeout: 90_000 });
    await openLastToolStep(page, 'List Flows');
    // Both halves on screen: the argument the tool ran with, and the result it produced.
    await expect(page.getByText('limit', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Listed \d+ flow\(s\)/)).toBeVisible({ timeout: 15_000 });
    await shot(page, '05-string-typed-numeric-argument-still-runs');

    // Two round-trips: the tool call, then the answer built from its result. The second one carries
    // both halves of the fix — the tool succeeded, and the arguments replayed to the model are the
    // coerced number, so the model is not being taught that a string is acceptable.
    expect(stub.requests).toHaveLength(2);
    expect(toolResultText(stub.requests[1])).toMatch(/Listed \d+ flow\(s\)/);
    expect(toolResultText(stub.requests[1])).not.toContain('Invalid input');
    expect(replayedToolArguments(stub.requests[1])).toContain('{"limit":5}');
  });

  // #265. A cold local model loads gigabytes of weights and evaluates a large prompt before it
  // sends anything; measured at 121 s against a 120 s bound on a real Ollama, which killed the
  // first message after every idle period. The stub withholds the response entirely — headers
  // included, because the headers are the first byte — for longer than the inter-chunk idle bound
  // and then streams normally.
  //
  // **No reload: the tab that asked is the tab that has to show the answer.** This used to reopen
  // the conversation, because the browser carried its own flat 120 s copy of the bound #266 split
  // on the server, tore down its socket handler at two minutes and reconciled against a
  // conversation that had not answered yet — the answer landed in the database and the open tab
  // never showed it (#289). The browser now derives both bounds from the server's own
  // (`HTTP_FIRST_BYTE_TIMEOUT_SECONDS` / `HTTP_STREAM_IDLE_TIMEOUT_SECONDS` on `/v1/flags`), so the
  // reopen is no longer needed and asserting on the open tab is what makes this the whole
  // behaviour rather than half of it.
  test('completes when the model withholds its first token past the inter-chunk idle bound (#265, #289)', async ({
    page,
  }) => {
    const answer = 'Sorry for the wait — I had to load first.';
    stub.script([delayedTextStream({ text: answer, delayFirstByteMs: COLD_START_DELAY_MS })]);

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openNewChat(page);
    const startedAt = Date.now();
    await sendChatMessage(
      page,
      `Cold start: the stub model will send nothing at all for ${COLD_START_DELAY_MS / 1000}s, past the ${STREAM_IDLE_BOUND_SECONDS}s inter-chunk bound.`,
    );

    await expect(page.getByText(answer)).toBeVisible({ timeout: 240_000 });
    await shot(page, '06-cold-start-answer-renders-in-the-tab-that-asked');

    // Guards against a stub that quietly answered at once: the answer is only evidence for #265 if
    // the silence really outlasted the inter-chunk bound.
    expect(Date.now() - startedAt).toBeGreaterThan(STREAM_IDLE_BOUND_SECONDS * 1000);
    expect(stub.requests).toHaveLength(1);
  });
});

// The list accumulates across runs on a long-lived instance, and a frame of ten unrelated rows
// proves nothing. The filter is live, so the term alone is enough.
async function openAutomationsFilteredBy(page: Page, term: string): Promise<void> {
  await page.goto('/automations');
  const search = page.getByPlaceholder(/Search flows/);
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(term);
}

// The automations table is div-based, so there is no `row` role to filter — `div.group` is the row
// wrapper (`automations-table.tsx`).
async function deleteFlowViaUI(page: Page, displayName: string): Promise<void> {
  const row = page.locator('div.group').filter({ hasText: displayName }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  // Retried as a whole: the list refetches while the filter above settles, so the row can be
  // replaced between opening its menu and reaching the item, and the menu goes with it.
  await expect(async () => {
    // `MoreHorizontal` is an alias of `Ellipsis` in lucide-react 0.576, so the emitted class is
    // `lucide-ellipsis`; both are matched because the alias class is what the older POM assumes.
    await row
      .locator('button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)')
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  const confirm = page.getByRole('dialog', { name: 'Delete flow' });
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(displayName)).toHaveCount(0, { timeout: 15_000 });
}

// `httpTimeouts.DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS` in `@aiqadam/shared` — and the value the single
// pre-#266 timer used for the first byte as well, which is what made a cold model fail. The browser
// used to carry a second copy of it; since #289 it reads the server's own value off `/v1/flags`.
//
// This is the one copy #289 did not remove, and it is a copy: `packages/tests-e2e` declares no
// dependency on `@aiqadam/shared`, so it cannot import the constant and nothing checks that the two
// agree. The blast radius is small — it is read only to phrase the log line below and to sanity-check
// that the stub really did outlast the bound, so a drift makes this test lie in its output rather
// than pass something broken — but it is not "no second literal left".
const STREAM_IDLE_BOUND_SECONDS = 120;

// Comfortably past that bound and comfortably inside the 300 s first-byte allowance that replaced
// it, so the run is decided by the deadline #266 introduced and by nothing else.
const COLD_START_DELAY_MS = 130_000;
