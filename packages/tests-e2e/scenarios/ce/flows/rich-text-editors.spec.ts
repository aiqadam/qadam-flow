import { test, expect } from '../../../fixtures';

/**
 * Browser-level coverage for the two tiptap editors (#669): the canvas note
 * (`MarkdownInput`) and the step-settings mention input (`TiptapEditor`).
 *
 * Heading, code and link rendering is deliberately NOT asserted: #668 is open
 * and `MarkdownInput` still lacks those extensions, so a heading note loads
 * blank and is overwritten on the first edit. Add those cases once #668 lands.
 */
test.describe('Rich text editors', () => {
  test('canvas note keeps bold, a list and literal characters across an edit and reload', async ({
    page,
    automationsPage,
    builderPage,
  }) => {
    test.setTimeout(120000);

    await automationsPage.waitFor();
    await automationsPage.newFlowFromScratch();
    await builderPage.waitFor();

    // The note control starts a drag overlay that follows the cursor; clicking
    // the overlay commits the note at that point.
    await page.locator('button:has(svg.lucide-sticky-note)').first().click();
    const overlay = page.locator('.note-drag-overlay');
    await expect(overlay).toBeVisible();

    const paneBox = await page.locator('.react-flow__pane').boundingBox();
    expect(paneBox, 'canvas pane should be visible').not.toBeNull();
    await page.mouse.move(
      paneBox!.x + paneBox!.width / 2,
      paneBox!.y + paneBox!.height / 2,
    );
    await overlay.click();

    const note = page.locator('.note-node');
    await expect(note).toBeVisible();

    // Notes are read-only until double-clicked.
    await note.dblclick();
    const editor = note.locator('[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await editor.focus();

    const saved = page.waitForResponse((response) =>
      isFlowUpdate(response, 'UPDATE_NOTE'),
    );
    await page.keyboard.type('**bold**', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('- first item', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('second item', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('snake_case 2 < 3 & ok', { delay: 20 });
    await saved;

    await page.reload();
    await builderPage.waitFor();

    const reloadedNote = page.locator('.note-node');
    await expect(reloadedNote).toBeVisible();
    await expect(reloadedNote.locator('strong')).toHaveText('bold');
    await expect(reloadedNote.locator('ul li')).toHaveCount(2);
    await expect(reloadedNote.locator('ul li').nth(0)).toContainText(
      'first item',
    );
    await expect(reloadedNote.locator('ul li').nth(1)).toContainText(
      'second item',
    );
    await expect(reloadedNote.getByText('snake_case 2 < 3 & ok')).toBeVisible();
  });

  test('step-settings mention input keeps a trigger reference across an edit and reload', async ({
    page,
    automationsPage,
    builderPage,
  }) => {
    test.setTimeout(180000);

    await automationsPage.waitFor();
    await automationsPage.newFlowFromScratch();
    await builderPage.waitFor();

    const triggerSaved = page.waitForResponse((response) =>
      isFlowUpdate(response, 'UPDATE_TRIGGER'),
    );
    await builderPage.selectInitialTrigger({
      piece: 'Webhook',
      trigger: 'Catch Webhook',
    });
    await triggerSaved;

    const flowId = extractFlowIdFromUrl(page.url());
    const { token } = await page.evaluate(() => ({
      token: localStorage.getItem('token'),
    }));

    // The data selector only offers a step's data once that step has sample
    // data; without it `traverseStep` renders a "test this step" placeholder.
    // Seeding it through the flow API keeps this spec on API + Vite, with no
    // worker or engine, which is what #660's hand-run stack had.
    const seeded = await page.context().request.post(`/api/v1/flows/${flowId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        type: 'SAVE_SAMPLE_DATA',
        request: {
          stepName: 'trigger',
          payload: { body: 'hello world' },
          type: 'OUTPUT',
        },
      },
    });
    expect(
      seeded.ok(),
      'sample data should be seeded for the trigger',
    ).toBeTruthy();

    await page.reload();
    await builderPage.waitFor();

    // Crypto's Base64 Encode is a core action with a single top-level text
    // prop, which the step settings render as the tiptap mention editor.
    // (A nested dynamic property only gets the mention editor when the action
    // has property settings, which a fresh action does not guarantee.)
    await page.getByTestId('add-action-button').last().click();
    await page.getByTestId('qadams-search-input').fill('Base64 Encode');
    const searchPopup = page.locator(
      '[data-slot="popover-content"]:has([data-testid="qadams-search-input"])',
    );
    await searchPopup
      .getByText('Base64 Encode', { exact: true })
      .first()
      .click();
    await page
      .locator('.react-flow__node')
      .filter({ hasText: 'Base64 Encode' })
      .last()
      .click();
    await page
      .locator('[data-slot="skeleton"]')
      .first()
      .waitFor({ state: 'detached', timeout: 15000 })
      .catch(() => undefined);

    const textField = page
      .locator('div.flex.flex-col', {
        has: page.getByText('Text', { exact: true }),
      })
      .last();
    const editor = textField.locator('.ap-text-with-mentions');
    await editor.click();

    const dataSelector = page.locator('.ap-data-selector');
    await expect(dataSelector).not.toHaveClass(/pointer-events-none/);
    await dataSelector.getByPlaceholder('Search').fill('body');
    await dataSelector.getByText('body', { exact: true }).click();

    // A step's output is always prefixed with `['output']` by the data
    // selector, so the inserted reference is the long form rather than the
    // `{{trigger['body']}}` shorthand the ticket sketches.
    const reference = "{{trigger['output']['body']}}";
    const chip = textField.locator('span[data-type="mention"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-id', reference);

    const saved = page.waitForResponse(
      (response) =>
        isFlowUpdate(response, 'UPDATE_ACTION') &&
        (response.request().postData() ?? '').includes('hello'),
    );
    await page.keyboard.press('End');
    await page.keyboard.type(' hello', { delay: 20 });
    await saved;

    await page.reload();
    await builderPage.waitFor();

    await page
      .locator('.react-flow__node')
      .filter({ hasText: 'Base64 Encode' })
      .last()
      .click();
    const reloadedField = page
      .locator('div.flex.flex-col', {
        has: page.getByText('Text', { exact: true }),
      })
      .last();
    await expect(reloadedField.locator('span[data-type="mention"]')).toBeVisible();

    const flowResponse = await page.context().request.get(
      `/api/v1/flows/${flowId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const flow = await flowResponse.json();
    const stored = String(
      flow?.version?.trigger?.nextAction?.settings?.input?.text,
    );
    expect(stored).toContain(reference);
    expect(stored).toContain('hello');
  });
});

function isFlowUpdate(
  response: import('@playwright/test').Response,
  operationType: string,
): boolean {
  if (response.request().method() !== 'POST') {
    return false;
  }
  if (!response.url().includes('/v1/flows/')) {
    return false;
  }
  const body = response.request().postData();
  return body !== null && body.includes(`"${operationType}"`);
}

function extractFlowIdFromUrl(url: string): string {
  const match = /\/flows\/([^/?]+)/.exec(url);
  if (!match) {
    throw new Error(`Could not extract a flow id from builder URL: ${url}`);
  }
  return match[1];
}
