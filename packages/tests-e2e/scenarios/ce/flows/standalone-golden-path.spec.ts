import { test, expect } from '../../../fixtures';

test.describe('Standalone golden path', () => {
  test('webhook trigger publishes and runs end-to-end', async ({ page, automationsPage, builderPage }) => {
    test.setTimeout(180000);

    await automationsPage.waitFor();
    await automationsPage.newFlowFromScratch();
    await builderPage.waitFor();

    await builderPage.selectInitialTrigger({
      piece: 'Webhook',
      trigger: 'Catch Webhook',
    });

    const webhookInput = page.locator('input.grow.bg-background');
    const webhookUrl = await webhookInput.inputValue();
    expect(webhookUrl, 'webhook URL should be assigned').toMatch(/\/api\/v1\/webhooks\/[A-Za-z0-9]+$/);

    await builderPage.addAction({
      piece: 'Webhook',
      action: 'Return Response',
    });

    await builderPage.publishFlow();

    const triggerResponse = await page.context().request.post(webhookUrl, {
      data: { hello: 'qadam' },
    });
    expect(triggerResponse.ok(), 'webhook should accept POST after publish').toBeTruthy();

    const runStatus = await waitForLatestRunStatus(page, { timeoutMs: 60000 });
    expect(runStatus, 'engine should execute the published flow successfully').toBe('SUCCEEDED');
  });
});

async function waitForLatestRunStatus(page: import('@playwright/test').Page, { timeoutMs }: { timeoutMs: number }): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.context().request.get('/api/v1/flow-runs?limit=1');
    if (response.ok()) {
      const body = await response.json();
      const status = body?.data?.[0]?.status;
      if (status && status !== 'RUNNING' && status !== 'SCHEDULED') {
        return status;
      }
    }
    await page.waitForTimeout(1000);
  }
  return null;
}
