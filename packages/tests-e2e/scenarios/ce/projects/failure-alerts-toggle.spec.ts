import path from 'path';

import { faker } from '@faker-js/faker';
import { test, expect, request as playwrightRequest } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_EMAIL ?? 'dev@ap.com';
const ADMIN_PASSWORD = process.env.E2E_PASSWORD ?? '12345678';
const API = 'http://localhost:3000';
const OWNER_PASSWORD = 'Owner2Pass!23';
const SHOTS = path.resolve(__dirname, '../../../screenshots/failure-alerts');

async function acceptInvitation(invitationToken: string) {
  const publicApi = await playwrightRequest.newContext({ baseURL: API });
  const res = await publicApi.post('/api/v1/user-invitations/accept', {
    data: { invitationToken },
  });
  expect(res.status()).toBe(200);
  await publicApi.dispose();
}

// #88: a non-platform-admin, as ADMIN of a team project they created, arms/disarms
// per-member flow-failure email alerts from the project's Team tab. Requires SMTP to be
// configured on the backend (otherwise the toggle is disabled with a hint) — the dev stack
// this runs against is booted with AP_SMTP_* set.
test.describe('Per-member failure alerts toggle (#88)', () => {
  test.setTimeout(120_000);

  test('non-admin owner enables failure alerts for a member and sees the toggle turn on', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `owner2+${suffix}@example.com`;
    const projectName = `E2E ${suffix} ${faker.animal.bird()}`;

    // --- Bootstrap: platform admin mints a NON-admin platform member (owner2). ---
    await page.goto('/sign-in');
    await page.getByTestId('sign-in-email').fill(ADMIN_EMAIL);
    await page.getByTestId('sign-in-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('sign-in-button').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });

    const adminToken = await page.evaluate(() => localStorage.getItem('token') ?? '');
    const adminApi = await playwrightRequest.newContext({
      baseURL: API,
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });
    const platformInvite = await adminApi.post('/api/v1/user-invitations', {
      data: { email: ownerEmail, type: 'PLATFORM', platformRole: 'MEMBER' },
    });
    expect(platformInvite.status()).toBe(201);
    const platformInviteToken = new URL((await platformInvite.json()).link).searchParams.get('token');
    if (!platformInviteToken) throw new Error('platform invitation token missing');
    await adminApi.dispose();
    await acceptInvitation(platformInviteToken);

    // --- owner2 (non-admin) signs up and creates a team project (becomes its ADMIN). ---
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await owner.goto('/sign-up');
    await owner.getByTestId('sign-up-first-name').fill('Nadia');
    await owner.getByTestId('sign-up-last-name').fill('NonAdmin');
    await owner.getByTestId('sign-up-email').fill(ownerEmail);
    await owner.getByTestId('sign-up-password').fill(OWNER_PASSWORD);
    await owner.getByTestId('sign-up-button').click();
    await owner.waitForURL((u) => !u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
    await owner.waitForLoadState('networkidle');

    const ownerToken = await owner.evaluate(() => localStorage.getItem('token') ?? '');
    const ownerApi = await playwrightRequest.newContext({
      baseURL: API,
      extraHTTPHeaders: { Authorization: `Bearer ${ownerToken}` },
    });
    const projRes = await ownerApi.post('/api/v1/projects', { data: { displayName: projectName } });
    expect(projRes.status()).toBe(201);
    const project = await projRes.json();
    await ownerApi.dispose();

    // --- owner2 opens the project → Settings → Team tab. ---
    await owner.goto(`/projects/${project.id}`);
    await owner.waitForLoadState('networkidle');
    await owner.getByTestId('project-settings-button').click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByTestId('project-settings-tab-team').click();

    // SMTP is configured on this backend → no hint, toggle enabled.
    await expect(
      dialog.getByText('Failure alerts require email (SMTP) to be configured for this platform.'),
    ).toHaveCount(0);

    const memberRow = dialog.getByTestId('project-member-row').filter({ hasText: ownerEmail });
    await expect(memberRow).toBeVisible({ timeout: 10_000 });
    const alertToggle = memberRow.getByRole('switch');
    await expect(alertToggle).toBeEnabled();
    await expect(alertToggle).not.toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/01-toggle-enabled-off.png`, fullPage: true });

    // Enable failure alerts → POST /v1/alerts → toggle turns on.
    const createPromise = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/alerts') && r.request().method() === 'POST',
    );
    await alertToggle.click();
    const createResp = await createPromise;
    expect(createResp.status()).toBeLessThan(300);
    await expect(alertToggle).toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/02-alerts-enabled-on.png`, fullPage: true });

    // The alert is now persisted for this receiver.
    const listApi = await playwrightRequest.newContext({
      baseURL: API,
      extraHTTPHeaders: { Authorization: `Bearer ${ownerToken}` },
    });
    const alertsRes = await listApi.get(`/api/v1/alerts?projectId=${project.id}`);
    expect(alertsRes.status()).toBe(200);
    const alertsBody = await alertsRes.json();
    expect(
      alertsBody.data?.some((a: { receiver: string }) => a.receiver.toLowerCase() === ownerEmail),
    ).toBe(true);
    await listApi.dispose();

    // Disable again → DELETE → toggle turns off.
    const deletePromise = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/alerts/') && r.request().method() === 'DELETE',
    );
    await alertToggle.click();
    const deleteResp = await deletePromise;
    expect(deleteResp.status()).toBeLessThan(300);
    await expect(alertToggle).not.toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/03-alerts-disabled-off.png`, fullPage: true });

    await ownerCtx.close();
  });
});
