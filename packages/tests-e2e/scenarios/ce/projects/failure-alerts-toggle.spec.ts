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

// #88: a non-platform-admin, as ADMIN of a team project they created, arms per-member
// flow-failure email alerts from the project's Team tab — both for themselves and for a
// member they invited. Requires SMTP to be configured on the backend (otherwise the toggle
// is disabled with a hint); the dev stack this runs against is booted with AP_SMTP_* set.
test.describe('Per-member failure alerts toggle (#88)', () => {
  test.setTimeout(150_000);

  test('non-admin owner enables failure alerts for themselves and for an invited member', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `owner2+${suffix}@example.com`;
    const memberEmail = `member+${suffix}@example.com`;
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

    const openTeamTab = async () => {
      await owner.getByTestId('project-settings-button').click();
      const dialog = owner.getByRole('dialog');
      await dialog.getByTestId('project-settings-tab-team').click();
      return dialog;
    };
    const rowFor = (dialog: ReturnType<typeof owner.getByRole>, email: string) =>
      dialog.getByTestId('project-member-row').filter({ hasText: email });

    // --- owner2 opens the project → Settings → Team tab. ---
    await owner.goto(`/projects/${project.id}`);
    await owner.waitForLoadState('networkidle');
    let dialog = await openTeamTab();

    // SMTP is configured on this backend → no hint, toggle enabled.
    await expect(
      dialog.getByText('Failure alerts require email (SMTP) to be configured for this platform.'),
    ).toHaveCount(0);

    // --- Phase 1: enable failure alerts for owner2 themselves. ---
    const ownerToggle = rowFor(dialog, ownerEmail).getByRole('switch');
    await expect(ownerToggle).toBeEnabled();
    await expect(ownerToggle).not.toBeChecked();
    const ownerAlertPromise = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/alerts') && r.request().method() === 'POST',
    );
    await ownerToggle.click();
    expect((await ownerAlertPromise).status()).toBeLessThan(300);
    await expect(ownerToggle).toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/01-owner-alerts-on.png`, fullPage: true });

    // --- Phase 2: invite a member from the Team tab; member accepts and signs up. ---
    await dialog.locator('#invite-email').fill(memberEmail);
    await dialog.getByRole('combobox').click();
    await owner.getByRole('option', { name: 'Editor' }).click();
    const invitePromise = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/user-invitations') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Invite' }).click();
    const memberInviteToken = new URL((await (await invitePromise).json()).link).searchParams.get('token');
    if (!memberInviteToken) throw new Error('member invitation token missing');
    await expect(dialog.getByText(memberEmail)).toBeVisible({ timeout: 10_000 });
    await owner.screenshot({ path: `${SHOTS}/02-member-invited-pending.png`, fullPage: true });

    await acceptInvitation(memberInviteToken);
    const memberCtx = await browser.newContext();
    const member = await memberCtx.newPage();
    await member.goto('/sign-up');
    await member.getByTestId('sign-up-first-name').fill('Marat');
    await member.getByTestId('sign-up-last-name').fill('Member');
    await member.getByTestId('sign-up-email').fill(memberEmail);
    await member.getByTestId('sign-up-password').fill('Member12345!');
    await member.getByTestId('sign-up-button').click();
    await member.waitForURL((u) => !u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
    await memberCtx.close();

    // --- Phase 3: owner2 reopens the Team tab and enables the invited member's alerts. ---
    await owner.reload();
    await owner.waitForLoadState('networkidle');
    dialog = await openTeamTab();

    const memberToggle = rowFor(dialog, memberEmail).getByRole('switch');
    await expect(memberToggle).toBeVisible({ timeout: 10_000 });
    await expect(memberToggle).toBeEnabled();
    await expect(memberToggle).not.toBeChecked();
    const memberAlertPromise = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/alerts') && r.request().method() === 'POST',
    );
    await memberToggle.click();
    expect((await memberAlertPromise).status()).toBeLessThan(300);
    await expect(memberToggle).toBeChecked();
    // Owner's alert stayed on too.
    await expect(rowFor(dialog, ownerEmail).getByRole('switch')).toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/03-both-members-alerts-on.png`, fullPage: true });

    // Both receivers are now persisted as alert channels.
    const alertsRes = await ownerApi.get(`/api/v1/alerts?projectId=${project.id}`);
    expect(alertsRes.status()).toBe(200);
    const receivers: string[] = (await alertsRes.json()).data.map((a: { receiver: string }) =>
      a.receiver.toLowerCase(),
    );
    expect(receivers).toContain(ownerEmail);
    expect(receivers).toContain(memberEmail);

    await ownerApi.dispose();
    await ownerCtx.close();
  });
});
