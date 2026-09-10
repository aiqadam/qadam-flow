import { test, expect } from '../../../fixtures';

const HOP_COUNT = 10;

// Unlike `Webhook`, the `Sub Flows` piece's action list renders each action name
// exactly once (no duplicate row for the piece-card preview), so the shared
// `builderPage.addAction()` helper's `.nth(1)` (tuned for Webhook) never resolves.
// `.last()` on the add-action button, because once several steps exist there is one
// such button per step (add-after), and we always want to append to the end.
async function addSubflowsAction(page: import('@playwright/test').Page, action: string) {
  await page.getByTestId('add-action-button').last().click();
  // Search by the ACTION's own name directly, skipping the intermediate
  // "click the Sub Flows piece card" hop — one less popover state transition,
  // which is where the flakiness below traces back to on a tight loop.
  await page.getByTestId('qadams-search-input').fill(action);
  // Scoped to the search popover (`data-slot="popover-content"`), not the
  // whole page: once a loop has already added a step with this same display
  // name, a bare `page.getByText(action).first()` can resolve to that
  // EXISTING canvas node instead of the popover's result row (canvas node
  // renders earlier in the DOM), clicking a stale target the popover then
  // visually overlaps — surfacing as "subtree intercepts pointer events".
  const searchPopup = page.locator('[data-slot="popover-content"]:has([data-testid="qadams-search-input"])');
  await searchPopup.getByText(action, { exact: true }).first().click();

  // Adding a step from the search dialog does NOT auto-open its settings
  // panel — the canvas just gets a new node. The panel only opens when the
  // node itself is clicked (ApStepCanvasNode's onClick -> selectStepByName).
  // Every prior flakiness theory (popover teardown, toast timing) was chasing
  // the wrong cause: `Select an option` was timing out because no panel was
  // open at all to contain it.
  // Scoped to `.react-flow__node` (not a bare getByText) because once the
  // settings panel is open, its own header repeats the action's display
  // name — an unscoped `.last()` can resolve to the panel instead of the
  // canvas node and misfire.
  await page.locator('.react-flow__node').filter({ hasText: action }).last().click();

  // The settings panel opens immediately but its fields render as
  // `data-slot="skeleton"` placeholders while piece props are still being
  // fetched. Interacting with the "Mode" dropdown while that fetch is still
  // in flight (observed directly in a trace screenshot) makes the props
  // resolver error out with three stacked "Something went wrong" boxes
  // instead of the JSON editor ever mounting. Wait for the skeleton to
  // clear before touching anything in the panel.
  await page.locator('[data-slot="skeleton"]').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
}

async function addCallFlowStep(page: import('@playwright/test').Page, executionMode: 'queue' | 'inline') {
  await addSubflowsAction(page, 'Call Flow');

  // "Flow": the only published Callable-Flow-triggered flow in the project, so
  // there is exactly one option every time this field is freshly added.
  await page.getByText('Select an option').first().click();
  await page.getByRole('option').first().click();

  // `waitForResponse` defaults to false, and when false, `callFlow` (queue
  // mode) does NOT create a waitpoint at all — it fires the child and moves
  // straight to the next step without waiting (see call-flow.ts: the
  // waitpoint/waitForWaitpoint block is gated entirely on this flag). Without
  // checking it, a "queue" chain here would be fire-and-forget on every hop
  // and finish almost instantly regardless of whether children ever complete
  // — not a genuine sequential chain, and not a fair comparison against
  // inline (which is always synchronous by design, no such shortcut exists).
  // This was root-caused directly: an isolated single-hop backend test with
  // waitForResponse implicitly true (the vitest fixture's default) showed
  // inline decisively FASTER (1074ms vs 2635ms) — the opposite of what an
  // earlier version of this UI test measured, because that version never
  // checked this box.
  // Rendered as a Radix `Switch` (role="switch") in a horizontal row, not the
  // vertical `div.flex.flex-col` wrapper the dropdown fields use — confirmed
  // directly from a trace screenshot after the `getByRole('checkbox')`
  // version timed out for the full 20-minute budget finding nothing.
  await page.locator('div.flex', {
    has: page.getByText('Wait for Response', { exact: true }),
  }).last().getByRole('switch').click();

  if (executionMode === 'inline') {
    // `has: getByText(...)` matches every ancestor `div.flex.flex-col` that
    // contains the label — several nested wrapper divs all share the class,
    // so the filter is a strict-mode violation (3 matches) without `.last()`
    // picking the innermost, tightest one.
    const executionModeField = page.locator('div.flex.flex-col', {
      has: page.getByText('Execution Mode', { exact: true }),
    }).last();
    await executionModeField.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Inline' }).click();
  }

  // Two things linger and cover the next "add action" search dialog if not
  // cleared explicitly: the just-closed dropdown's own Radix popper (its exit
  // animation/portal can still intercept clicks for a beat after selection)
  // and an autosave toast (top-center, fixed) fired by the field change.
  // Escape guarantees any open popover actually unmounts; the wait lets the
  // toast's fade-out finish.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
}

async function goToAutomations(page: import('@playwright/test').Page, automationsPage: { waitFor: () => Promise<void> }) {
  await page.goto('/automations');
  await automationsPage.waitFor();
}

test.describe('Inline subflow (#363)', () => {
  test(`queue vs inline: two root flows, each calling the same subflow ${HOP_COUNT}x sequentially`, async ({
    page,
    automationsPage,
    builderPage,
  }) => {
    test.setTimeout(20 * 60 * 1000); // 10 build/config iterations per root flow plus both chains' run time

    // Clean slate: the callFlow "Flow" picker lists every published flow with a
    // Callable Flow trigger in the project, so a leftover flow from another spec
    // would make it ambiguous which option to click.
    await automationsPage.waitFor();
    await automationsPage.cleanupExistingAutomations();

    // --- Child flow: Callable Flow trigger -> Return Response (the thing both root flows call) ---
    await automationsPage.newFlowFromScratch();
    await builderPage.waitFor();

    await builderPage.selectInitialTrigger({
      piece: 'Sub Flows',
      trigger: 'Callable Flow',
    });

    await addSubflowsAction(page, 'Return Response');

    // "Mode" is itself a StaticDropdown combobox (Simple/Advanced), not a toggle
    // button — switch it to Advanced so "Response" becomes a JSON editor. It's
    // the only combobox in the step-settings panel at this point.
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Advanced' }).click();

    // "response" is a DynamicProperties field with `refreshers: ['mode']`
    // (see qadams/core/subflows/src/lib/actions/respond.ts) — switching Mode
    // triggers a fresh backend round-trip to re-resolve the field definition
    // (Object -> Json), rendered as a SkeletonList while `isPending`. Racing
    // this refetch is what produced a blank panel with no editor at all.
    await page.locator('[data-slot="skeleton"]').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    await page.locator('div.cm-activeLine.cm-line').fill('');
    await page.locator('div.cm-activeLine.cm-line').fill('{"level": "child", "ranInline": true}');
    await page.waitForTimeout(1000);

    await builderPage.publishFlow();

    // --- Root flow A: Webhook trigger -> Call Flow x10, executionMode "queue" ---
    await goToAutomations(page, automationsPage);
    await automationsPage.newFlowFromScratch();
    await builderPage.waitFor();

    await builderPage.selectInitialTrigger({
      piece: 'Webhook',
      trigger: 'Catch Webhook',
    });

    const queueWebhookUrl = await page.locator('input.grow.bg-background').inputValue();
    const queueFlowId = extractFlowIdFromUrl(page.url());

    for (let i = 0; i < HOP_COUNT; i++) {
      await addCallFlowStep(page, 'queue');
    }

    await builderPage.publishFlow();

    // --- Root flow B: Webhook trigger -> Call Flow x10, executionMode "inline" ---
    await goToAutomations(page, automationsPage);
    await automationsPage.newFlowFromScratch();
    await builderPage.waitFor();

    await builderPage.selectInitialTrigger({
      piece: 'Webhook',
      trigger: 'Catch Webhook',
    });

    const inlineWebhookUrl = await page.locator('input.grow.bg-background').inputValue();
    const inlineFlowId = extractFlowIdFromUrl(page.url());

    for (let i = 0; i < HOP_COUNT; i++) {
      await addCallFlowStep(page, 'inline');
    }

    await builderPage.publishFlow();

    // --- Trigger both chains and measure wall-clock time to SUCCEEDED ---
    const queueStartedAt = Date.now();
    const queueTrigger = await page.context().request.post(queueWebhookUrl, { data: {} });
    expect(queueTrigger.ok(), 'queue-chain webhook should accept POST after publish').toBeTruthy();
    // Filtered by the ROOT flow's own id, not just "latest run in the
    // project": an inline chain creates child-run rows synchronously during
    // the parent's own execution, so an unfiltered "latest run" query can
    // resolve to the deepest child instead of the root once inline hops are
    // involved (observed directly — it returned the child flow's own run).
    const queueRun = await waitForLatestRun(page, { flowId: queueFlowId, timeoutMs: 5 * 60 * 1000 });
    const queueMs = Date.now() - queueStartedAt;
    expect(queueRun?.status, `queue chain (${HOP_COUNT}x) should succeed`).toBe('SUCCEEDED');

    const inlineStartedAt = Date.now();
    const inlineTrigger = await page.context().request.post(inlineWebhookUrl, { data: {} });
    expect(inlineTrigger.ok(), 'inline-chain webhook should accept POST after publish').toBeTruthy();
    const inlineRun = await waitForLatestRun(page, { flowId: inlineFlowId, timeoutMs: 5 * 60 * 1000 });
    const inlineMs = Date.now() - inlineStartedAt;
    expect(inlineRun?.status, `inline chain (${HOP_COUNT}x) should succeed`).toBe('SUCCEEDED');

    // eslint-disable-next-line no-console
    console.log(
      `\n[inline-subflow] ${HOP_COUNT}-hop chain — queue: ${queueMs}ms, inline: ${inlineMs}ms, ` +
        `delta: ${queueMs - inlineMs}ms (${(100 * (queueMs - inlineMs) / queueMs).toFixed(1)}% faster)\n` +
        `queue run:  /runs/${queueRun!.id}\n` +
        `inline run: /runs/${inlineRun!.id}\n`,
    );
    expect(inlineMs, 'inline chain should be faster than the queue chain').toBeLessThan(queueMs);

    // "журнал" — leave both runs' detail pages reachable for manual inspection;
    // just prove the run-detail view actually renders the inline chain's steps.
    await page.goto(`/runs/${inlineRun!.id}`);
    await page.waitForSelector('.react-flow__node', { state: 'visible' });
    await expect(page.getByText('Call Flow').first()).toBeVisible();
  });
});

function extractFlowIdFromUrl(url: string): string {
  const match = /\/flows\/([^/?]+)/.exec(url);
  if (!match) {
    throw new Error(`Could not extract a flow id from builder URL: ${url}`);
  }
  return match[1];
}

async function waitForLatestRun(
  page: import('@playwright/test').Page,
  { flowId, timeoutMs }: { flowId: string, timeoutMs: number },
): Promise<{ id: string; status: string } | null> {
  const { projectId, token } = await page.evaluate(() => ({
    projectId: localStorage.getItem('projectId'),
    token: localStorage.getItem('token'),
  }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.context().request.get(`/api/v1/flow-runs?limit=1&projectId=${projectId}&flowId=${flowId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok()) {
      const body = await response.json();
      const run = body?.data?.[0];
      if (
        run?.status &&
        run.status !== 'RUNNING' &&
        run.status !== 'SCHEDULED' &&
        run.status !== 'QUEUED' &&
        run.status !== 'PAUSED'
      ) {
        return { id: run.id, status: run.status };
      }
    }
    await page.waitForTimeout(1000);
  }
  return null;
}
