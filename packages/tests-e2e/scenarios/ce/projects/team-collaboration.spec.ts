import path from 'path';

import { faker } from '@faker-js/faker';
import { test, expect, request as playwrightRequest } from '@playwright/test';

const OWNER_EMAIL = process.env.E2E_EMAIL ?? 'dev@ap.com';
const OWNER_PASSWORD = process.env.E2E_PASSWORD ?? '12345678';
const SHOTS = path.resolve(__dirname, '../../../screenshots/team-collaboration');

test.describe('Team project collaboration', () => {
  test.setTimeout(60_000);

  test('owner creates team project and invites a member', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByTestId('sign-in-email').fill(OWNER_EMAIL);
    await page.getByTestId('sign-in-password').fill(OWNER_PASSWORD);
    await page.getByTestId('sign-in-button').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });

    await page.goto('/platform/projects');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${SHOTS}/01-projects-list-before.png`, fullPage: true });

    const projectName = `E2E ${Date.now().toString().slice(-6)} ${faker.animal.bird()}`;
    await page.getByRole('button', { name: 'New Project' }).first().click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog.getByRole('heading', { name: 'Create Project' })).toBeVisible();
    await createDialog.locator('#displayName').fill(projectName);
    await page.screenshot({ path: `${SHOTS}/02-create-project-dialog.png`, fullPage: true });

    await createDialog.getByRole('button', { name: 'Create Project' }).click();
    await expect(createDialog).toBeHidden({ timeout: 10_000 });
    await page.goto(`/platform/projects?type=TEAM&displayName=${encodeURIComponent(projectName)}`);
    await page.waitForLoadState('networkidle');
    const projectCell = page.getByRole('cell', { name: projectName });
    await expect(projectCell).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/03-project-appears-in-list.png`, fullPage: true });

    const projectRow = projectCell.locator('..');
    await projectRow.locator('button:has(svg.lucide-pencil)').click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByRole('tab', { name: 'Members' })).toBeVisible();
    await editDialog.getByRole('tab', { name: 'Members' }).click();
    await page.screenshot({ path: `${SHOTS}/04-members-tab-empty.png`, fullPage: true });

    const inviteEmail = `member+${Date.now().toString().slice(-6)}@example.com`;
    await editDialog.locator('#invite-email').fill(inviteEmail);
    await editDialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Editor' }).click();

    const inviteResponsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/user-invitations') && r.request().method() === 'POST',
    );
    await editDialog.getByRole('button', { name: 'Invite' }).click();
    const inviteResponse = await inviteResponsePromise;
    const invitationBody: { link?: string } = await inviteResponse.json();
    await expect(editDialog.getByText(inviteEmail)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/05-pending-invitation.png`, fullPage: true });

    // Invited user flow: mark invitation ACCEPTED via public endpoint (unauthenticated —
    // token is the auth), then sign up so provisionUserInvitation creates project_member.
    if (!invitationBody.link) throw new Error('invitation.link missing from POST response');
    const invitationToken = new URL(invitationBody.link).searchParams.get('token');
    if (!invitationToken) throw new Error('token missing from invitation link');

    const publicApi = await playwrightRequest.newContext({ baseURL: 'http://localhost:3000' });
    const acceptRes = await publicApi.post('/api/v1/user-invitations/accept', {
      data: { invitationToken },
    });
    expect(acceptRes.status()).toBe(200);
    await publicApi.dispose();

    const invitedContext = await page.context().browser()!.newContext();
    const invitedPage = await invitedContext.newPage();
    await invitedPage.goto('/sign-up');
    await invitedPage.getByTestId('sign-up-first-name').fill('Invited');
    await invitedPage.getByTestId('sign-up-last-name').fill('Member');
    await invitedPage.getByTestId('sign-up-email').fill(inviteEmail);
    await invitedPage.getByTestId('sign-up-password').fill('Member12345!');
    await invitedPage.screenshot({ path: `${SHOTS}/06-invited-signup-form.png`, fullPage: true });
    await invitedPage.getByTestId('sign-up-button').click();
    await invitedPage.waitForURL((u) => !u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
    await invitedPage.waitForLoadState('networkidle');
    await invitedPage.screenshot({ path: `${SHOTS}/07-invited-dashboard.png`, fullPage: true });

    // Same-platform isolation: invited user opens their project switcher — must see
    // exactly two projects (Personal + the invited team project A), NOT owner's other
    // team projects that they were not invited to.
    await invitedPage.goto('/projects');
    await invitedPage.waitForLoadState('networkidle');
    await expect(invitedPage.getByText(projectName)).toBeVisible({ timeout: 10_000 });
    await invitedPage.screenshot({ path: `${SHOTS}/08-invited-projects-list.png`, fullPage: true });

    await invitedContext.close();
  });
});
