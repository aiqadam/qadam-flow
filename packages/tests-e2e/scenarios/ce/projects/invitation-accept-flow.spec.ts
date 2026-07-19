import path from 'path';

import { faker } from '@faker-js/faker';
import { test, expect, request as playwrightRequest } from '@playwright/test';

const OWNER_EMAIL = process.env.E2E_EMAIL ?? 'dev@ap.com';
const OWNER_PASSWORD = process.env.E2E_PASSWORD ?? '12345678';
const SHOTS = path.resolve(__dirname, '../../../screenshots/invitation-accept-flow');

test.describe('Invitation accept flow (Option A)', () => {
  test.setTimeout(90_000);

  test('logged-out invitee: /invitation?token=... accepts then routes to /sign-up with pre-filled email', async ({ page, browser }) => {
    // Owner: log in, create team project, invite editor
    await page.goto('/sign-in');
    await page.getByTestId('sign-in-email').fill(OWNER_EMAIL);
    await page.getByTestId('sign-in-password').fill(OWNER_PASSWORD);
    await page.getByTestId('sign-in-button').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });

    const projectName = `E2E ${Date.now().toString().slice(-6)} ${faker.animal.bird()}`;
    const inviteEmail = `invitee+opta_${Date.now().toString().slice(-6)}@example.com`;

    const authToken = await page.evaluate(() => localStorage.getItem('token') ?? '');
    expect(authToken).toBeTruthy();

    const adminApi = await playwrightRequest.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { Authorization: `Bearer ${authToken}` },
    });
    const proj = await adminApi.post('/api/v1/projects', {
      data: { displayName: projectName },
    });
    expect(proj.status()).toBe(201);
    const projBody = await proj.json();

    const invRes = await adminApi.post('/api/v1/user-invitations', {
      headers: { 'x-ap-project-id': projBody.id },
      data: {
        email: inviteEmail,
        type: 'PROJECT',
        projectId: projBody.id,
        projectRole: 'Editor',
      },
    });
    expect(invRes.status()).toBe(201);
    const invBody = await invRes.json();
    const invitationToken = new URL(invBody.link).searchParams.get('token');
    expect(invitationToken).toBeTruthy();
    await adminApi.dispose();

    // Logged-out invitee opens the invitation link
    const invitedContext = await browser.newContext();
    const invitedPage = await invitedContext.newPage();

    const acceptResponsePromise = invitedPage.waitForResponse(
      (r) => r.url().includes('/api/v1/user-invitations/accept') && r.request().method() === 'POST',
    );
    await invitedPage.goto(`/invitation?token=${invitationToken}`);
    await invitedPage.screenshot({ path: `${SHOTS}/01-invitation-page-loaded.png`, fullPage: true });

    const acceptRes = await acceptResponsePromise;
    expect(acceptRes.status()).toBe(200);

    // Should auto-navigate to /sign-up with the invitee email pre-filled
    await invitedPage.waitForURL((u) => u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
    await invitedPage.screenshot({ path: `${SHOTS}/02-signup-page-after-accept.png`, fullPage: true });

    const emailField = invitedPage.getByTestId('sign-up-email');
    await expect(emailField).toHaveValue(inviteEmail);
    await invitedPage.screenshot({ path: `${SHOTS}/03-signup-email-prefilled.png`, fullPage: true });

    // Complete signup — must succeed (invitation is already ACCEPTED, so no INVITATION_ONLY_SIGN_UP)
    await invitedPage.getByTestId('sign-up-first-name').fill('Invited');
    await invitedPage.getByTestId('sign-up-last-name').fill('User');
    await invitedPage.getByTestId('sign-up-password').fill('Passw0rd!');
    await invitedPage.getByTestId('sign-up-button').click();
    await invitedPage.waitForURL((u) => !u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
    await invitedPage.waitForLoadState('networkidle');
    await invitedPage.screenshot({ path: `${SHOTS}/04-signup-succeeded.png`, fullPage: true });

    // Invited user's own /v1/projects must include the team project with Editor access
    const invitedToken = await invitedPage.evaluate(() => localStorage.getItem('token') ?? '');
    const invitedApi = await playwrightRequest.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { Authorization: `Bearer ${invitedToken}` },
    });
    const projectsRes = await invitedApi.get('/api/v1/projects');
    expect(projectsRes.status()).toBe(200);
    const projectsBody = await projectsRes.json();
    const teamProject = projectsBody.data?.find((p: { displayName: string }) => p.displayName === projectName);
    expect(teamProject, `invitee should see team project ${projectName}`).toBeTruthy();
    await invitedApi.dispose();
    await invitedPage.screenshot({ path: `${SHOTS}/05-signup-complete-dashboard.png`, fullPage: true });

    await invitedContext.close();
  });

  test('logged-in owner: /invitation?token=... shows success card + Go to projects', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByTestId('sign-in-email').fill(OWNER_EMAIL);
    await page.getByTestId('sign-in-password').fill(OWNER_PASSWORD);
    await page.getByTestId('sign-in-button').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });

    const authToken = await page.evaluate(() => localStorage.getItem('token') ?? '');
    const adminApi = await playwrightRequest.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { Authorization: `Bearer ${authToken}` },
    });
    const projectName = `E2E ${Date.now().toString().slice(-6)} logged-in`;
    const proj = await adminApi.post('/api/v1/projects', { data: { displayName: projectName } });
    const projBody = await proj.json();
    const inviteEmail = `member+logged_${Date.now().toString().slice(-6)}@example.com`;
    const invRes = await adminApi.post('/api/v1/user-invitations', {
      headers: { 'x-ap-project-id': projBody.id },
      data: { email: inviteEmail, type: 'PROJECT', projectId: projBody.id, projectRole: 'Editor' },
    });
    const invitationToken = new URL((await invRes.json()).link).searchParams.get('token');
    await adminApi.dispose();

    await page.goto(`/invitation?token=${invitationToken}`);
    await expect(page.getByText('Invitation accepted successfully')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Go to projects' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-logged-in-success-card.png`, fullPage: true });
  });

  test('invalid token: friendly error copy, no global dialog', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByTestId('sign-in-email').fill(OWNER_EMAIL);
    await page.getByTestId('sign-in-password').fill(OWNER_PASSWORD);
    await page.getByTestId('sign-in-button').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });

    await page.goto('/invitation?token=not-a-jwt');
    await expect(page.getByText('Invalid or expired invitation link')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/07-invalid-token-friendly-copy.png`, fullPage: true });
  });
});
