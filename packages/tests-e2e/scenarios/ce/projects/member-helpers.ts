import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { DEFAULT_EMAIL, DEFAULT_PASSWORD } from '../../../global-setup';

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByTestId('sign-in-email').fill(email);
  await page.getByTestId('sign-in-password').fill(password);
  await page.getByTestId('sign-in-button').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });
}

// An admin invites a MEMBER to the platform from the platform Users page (Invite user →
// dialog → POST). Returns the invitation link (read from the click's response). This mints
// the non-admin test actor entirely through the UI.
export async function issuePlatformMemberInviteViaUI(
  adminPage: Page,
  email: string,
  shot?: Shot,
): Promise<string> {
  await adminPage.goto('/platform/users');
  await adminPage.getByTestId('invite-platform-user-button').click();
  const dialog = adminPage.getByRole('dialog');
  await dialog.locator('#platform-invite-email').fill(email);
  const invitePromise = adminPage.waitForResponse(
    (r) => r.url().includes('/api/v1/user-invitations') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Invite' }).click();
  const link = (await (await invitePromise).json()).link as string;
  if (!link) throw new Error('platform invitation link missing');
  await expect(dialog.getByText('Invitation link')).toBeVisible({ timeout: 10_000 });
  await shot?.(adminPage, 'admin-invites-platform-member');
  return link;
}

// Accept a pending invitation by opening its link in the browser (the /invitation page
// auto-accepts and routes to /sign-up with the email pre-filled), then complete signup.
export async function acceptInviteAndSignUp(
  context: BrowserContext,
  invitationLink: string,
  { firstName, lastName, password }: { firstName: string; lastName: string; password: string },
  shot?: Shot,
): Promise<Page> {
  const token = new URL(invitationLink).searchParams.get('token');
  if (!token) throw new Error('invitation token missing from link');
  const page = await context.newPage();
  await page.goto(`/invitation?token=${token}`);
  await page.waitForURL((u) => u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
  await page.getByTestId('sign-up-first-name').fill(firstName);
  await page.getByTestId('sign-up-last-name').fill(lastName);
  await page.getByTestId('sign-up-password').fill(password);
  await shot?.(page, 'signup-form-prefilled');
  await page.getByTestId('sign-up-button').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-up'), { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  return page;
}

// Create a team project through the sidebar UI; returns the new project id from the URL.
export async function createTeamProjectViaUI(
  page: Page,
  displayName: string,
  shot?: Shot,
): Promise<string> {
  await page.getByTestId('create-team-project-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create Project' })).toBeVisible({ timeout: 10_000 });
  await dialog.locator('#displayName').fill(displayName);
  await shot?.(page, 'create-project-dialog');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await page.waitForLoadState('networkidle');
  const match = page.url().match(/\/projects\/([^/?#]+)/);
  if (!match) throw new Error('project id not found in URL after create');
  return match[1];
}

// Open the project's Settings → Team tab; returns the dialog locator.
export async function openTeamTab(page: Page): Promise<Locator> {
  await page.getByTestId('project-settings-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('project-settings-tab-team').click();
  return dialog;
}

// Invite a member from the open Team tab; returns the invitation link (read from the
// POST response of the real "Invite" click).
export async function inviteMemberViaTeamTab(
  page: Page,
  dialog: Locator,
  email: string,
): Promise<string> {
  await dialog.locator('#invite-email').fill(email);
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Editor' }).click();
  const invitePromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/user-invitations') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Invite' }).click();
  const link = (await (await invitePromise).json()).link as string;
  if (!link) throw new Error('member invitation link missing');
  return link;
}

export function memberRow(dialog: Locator, email: string): Locator {
  return dialog.getByTestId('project-member-row').filter({ hasText: email });
}

export type Shot = (page: Page, name: string) => Promise<void>;

// Fall back to whoever global-setup itself authenticated as, so a fresh instance with no
// E2E_* env vars signs in as the user global-setup just signed up rather than a dev-seed
// user that does not exist there.
export const ADMIN_EMAIL = process.env.E2E_EMAIL ?? DEFAULT_EMAIL;
export const ADMIN_PASSWORD = process.env.E2E_PASSWORD ?? DEFAULT_PASSWORD;
export const OWNER_PASSWORD = 'Owner2Pass!23';
export const MEMBER_PASSWORD = 'Member12345!';
