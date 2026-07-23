import path from 'path';

import { faker } from '@faker-js/faker';
import { test, expect, request as playwrightRequest } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_EMAIL ?? 'dev@ap.com';
const ADMIN_PASSWORD = process.env.E2E_PASSWORD ?? '12345678';
const API = 'http://localhost:3000';
const OWNER_PASSWORD = 'Owner2Pass!23';
const SHOTS = path.resolve(__dirname, '../../../screenshots/team-collaboration');

async function acceptInvitation(invitationToken: string) {
  const publicApi = await playwrightRequest.newContext({ baseURL: API });
  const res = await publicApi.post('/api/v1/user-invitations/accept', {
    data: { invitationToken },
  });
  expect(res.status()).toBe(200);
  await publicApi.dispose();
}

// Golden path for the feature the platform-admin projects page is NOT the home of:
// a NON-platform-admin, as the ADMIN of a team project they created, manages members
// entirely from project settings (never touching /platform, which is admin-gated).
test.describe('Non-admin project owner manages team members', () => {
  test.setTimeout(120_000);

  test('non-admin creates a team project, invites a member from project settings, and sees the accepted member', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `owner2+${suffix}@example.com`;
    const memberEmail = `member+${suffix}@example.com`;
    const projectName = `E2E ${suffix} ${faker.animal.bird()}`;

    // --- Bootstrap: the platform admin mints a NON-admin platform member (owner2). ---
    // The admin is used ONLY to create the non-admin actor; the scenario itself is
    // driven entirely by owner2 below.
    await page.goto('/sign-in');
    await page.getByTestId('sign-in-email').fill(ADMIN_EMAIL);
    await page.getByTestId('sign-in-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('sign-in-button').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });

    const adminToken = await page.evaluate(() => localStorage.getItem('token') ?? '');
    expect(adminToken).toBeTruthy();
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

    // --- owner2 (non-admin) signs up in their own browser context and drives the rest. ---
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
    await owner.screenshot({ path: `${SHOTS}/01-nonadmin-signed-up.png`, fullPage: true });

    // Prove owner2 is NOT a platform admin: /platform is admin-gated and redirects away.
    await owner.goto('/platform/projects');
    await owner.waitForURL((u) => !u.pathname.startsWith('/platform'), { timeout: 10_000 });
    await owner.screenshot({ path: `${SHOTS}/02-nonadmin-blocked-from-platform.png`, fullPage: true });

    // owner2 creates a TEAM project — becomes its project ADMIN; default roles auto-seed.
    const ownerToken = await owner.evaluate(() => localStorage.getItem('token') ?? '');
    const ownerApi = await playwrightRequest.newContext({
      baseURL: API,
      extraHTTPHeaders: { Authorization: `Bearer ${ownerToken}` },
    });
    const projRes = await ownerApi.post('/api/v1/projects', { data: { displayName: projectName } });
    expect(projRes.status()).toBe(201);
    const project = await projRes.json();

    // --- owner2 opens the project → Settings → Team tab (the non-platform surface). ---
    await owner.goto(`/projects/${project.id}`);
    await owner.waitForLoadState('networkidle');
    await owner.getByTestId('project-settings-button').click();
    const dialog = owner.getByRole('dialog');
    await expect(dialog.getByTestId('project-settings-tab-team')).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId('project-settings-tab-team').click();
    await owner.screenshot({ path: `${SHOTS}/03-team-tab-open.png`, fullPage: true });

    // owner2 invites a member through the Team tab's invite form.
    await dialog.locator('#invite-email').fill(memberEmail);
    await dialog.getByRole('combobox').click();
    await owner.getByRole('option', { name: 'Editor' }).click();
    const invitePromise = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/user-invitations') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Invite' }).click();
    const inviteResp = await invitePromise;
    expect(inviteResp.status()).toBe(201);
    const memberInviteToken = new URL((await inviteResp.json()).link).searchParams.get('token');
    if (!memberInviteToken) throw new Error('member invitation token missing');
    await expect(dialog.getByText(memberEmail)).toBeVisible({ timeout: 10_000 });
    await owner.screenshot({ path: `${SHOTS}/04-invite-sent-pending.png`, fullPage: true });

    // Member accepts (public endpoint) then signs up so a project_member row is created.
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

    // --- owner2 (non-admin) reopens the Team tab and sees the ACCEPTED member listed. ---
    await owner.reload();
    await owner.waitForLoadState('networkidle');
    await owner.getByTestId('project-settings-button').click();
    const dialogAfter = owner.getByRole('dialog');
    await dialogAfter.getByTestId('project-settings-tab-team').click();

    const memberRow = dialogAfter
      .getByTestId('project-member-row')
      .filter({ hasText: memberEmail });
    await expect(memberRow).toBeVisible({ timeout: 10_000 });
    // #88: the per-member failure-alerts toggle is present on the row.
    await expect(memberRow.getByRole('switch')).toBeVisible();
    await owner.screenshot({ path: `${SHOTS}/05-nonadmin-sees-member-list.png`, fullPage: true });

    await ownerApi.dispose();
    await ownerCtx.close();
  });
});
