import { promises as fs } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  acceptInviteAndSignUp,
  createTeamProjectViaUI,
  issuePlatformMemberInviteViaUI,
  openTeamTab,
  signIn,
} from '../projects/member-helpers';

/**
 * Release acceptance for v2.0.0 — the milestone features that ship with **no UI evidence**.
 *
 * Everything asserted here is already covered at some layer: #93 by
 * `project-member.test.ts`, #304 by `locale-utils.test.ts`, #300 by `theme-utils.test.ts`,
 * the mailer by `mail/` integration tests. None of that shows what a person actually sees,
 * which is what a release acceptance is for. Every assertion below is a DOM assertion after a
 * real click, and every step writes a numbered frame to `screenshots/v2-acceptance/`.
 *
 * Serial and single-worker: the tests share one platform, and the locale/theme cases mutate
 * settings that are per-user rather than per-tab.
 *
 * **Mail needs Mailpit, and Mailpit needs a certificate the app trusts.**
 * `smtp-email-sender.ts#initSmtpClient` sets `requireTLS: !useSSL` and passes no `tls` options,
 * so nodemailer does a mandatory STARTTLS upgrade with verification left on — a stock Mailpit's
 * self-signed cert is rejected. Boot the stack with the acceptance compose override, which mounts
 * a cert issued for the name the app dials and points `NODE_EXTRA_CA_CERTS` at it, then set
 * `E2E_MAILPIT_URL`. Without it the mail case skips rather than passing vacuously.
 */
test.describe('v2.0.0 release acceptance — features with no UI coverage', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('an invitation sent from the UI arrives as a real email (#SMTP, mailer)', async ({
    page,
  }) => {
    test.skip(
      process.env.E2E_MAILPIT_URL === undefined,
      'needs a Mailpit whose TLS certificate the app trusts; set E2E_MAILPIT_URL',
    );
    const mailpit = process.env.E2E_MAILPIT_URL as string;
    const invitee = `mail-acceptance+${Date.now().toString().slice(-6)}@example.com`;

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await shot(page, '01-signed-in-as-platform-admin');

    await issuePlatformMemberInviteViaUI(page, invitee);
    await shot(page, '02-invitation-sent-from-the-platform-users-page');

    // The UI is the sender; Mailpit's own UI is the receipt. Poll its API only to know when to
    // take the frame — the assertion itself is on what Mailpit renders in the browser.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${mailpit}/api/v1/messages`);
          const body = (await res.json()) as { messages: { To: { Address: string }[] }[] };
          return body.messages.some((m) => m.To.some((t) => t.Address === invitee));
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(true);

    await page.goto(mailpit);
    await expect(page.getByText(invitee).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, '03-mailpit-inbox-lists-the-invitation');

    await page.getByText(invitee).first().click();
    await expect(page.getByText(/invited/i).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, '04-the-invitation-email-as-the-recipient-sees-it');
  });

  test('a password reset sends a real email with a working link (mailer, OTP)', async ({
    page,
  }) => {
    test.skip(
      process.env.E2E_MAILPIT_URL === undefined,
      'needs a Mailpit whose TLS certificate the app trusts; set E2E_MAILPIT_URL',
    );
    const mailpit = process.env.E2E_MAILPIT_URL as string;
    const before = await messageCount(page, mailpit);

    await page.goto('/forget-password');
    await page.locator('#email').fill(ADMIN_EMAIL);
    await page.getByRole('button', { name: /Send Password Reset Link/i }).click();
    await expect(page.getByText(/Check Your Inbox/i)).toBeVisible({ timeout: 30_000 });
    await shot(page, '16-password-reset-requested');

    // The UI says "check your inbox"; this is the part that checks the inbox.
    await expect
      .poll(async () => messageCount(page, mailpit), { timeout: 60_000, intervals: [1000] })
      .toBeGreaterThan(before);

    await page.goto(mailpit);
    const resetRow = page.getByText(/Reset your password/i).first();
    await expect(resetRow).toBeVisible({ timeout: 30_000 });
    await resetRow.click();
    await shot(page, '17-the-password-reset-email');
  });

  test('a project Viewer is not offered controls the server would refuse (#93)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `acceptance-owner+${suffix}@example.com`;
    const viewerEmail = `viewer+${suffix}@example.com`;

    // A fresh platform member, not the admin: `useIsCreateProjectDisabled` renders the
    // create-team-project control as a *disabled* button with no test id once the signed-in user
    // already owns a team project (`TeamProjectsLimit.ONE`), and the admin accumulates one per
    // suite run. A new member owns none, which is also the path a real operator takes.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ownerLink = await issuePlatformMemberInviteViaUI(page, ownerEmail);

    const ownerContext = await browser.newContext();
    const ownerPage = await acceptInviteAndSignUp(ownerContext, ownerLink, {
      firstName: 'Acc',
      lastName: 'Owner',
      password: 'Owner2Pass!23',
    });
    const projectId = await createTeamProjectViaUI(ownerPage, `Acceptance ${suffix}`);

    const dialog = await openTeamTab(ownerPage);
    await dialog.locator('#invite-email').fill(viewerEmail);
    await dialog.getByRole('combobox').click();
    await ownerPage.getByRole('option', { name: 'Viewer' }).click();
    const invitePromise = ownerPage.waitForResponse(
      (r) => r.url().includes('/api/v1/user-invitations') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Invite' }).click();
    const link = (await (await invitePromise).json()).link as string;
    await shot(ownerPage, '05-project-admin-invited-a-viewer');
    await ownerPage.keyboard.press('Escape');

    // The project ADMIN's own view of the page the Viewer is about to see, for the side-by-side.
    await ownerPage.goto(`/projects/${projectId}/automations`);
    await ownerPage.waitForLoadState('networkidle');
    // The empty state's "Start from scratch" under **Build a Flow** is the control that carries the
    // gate (`ActionRow` takes `hasPermission={userHasPermissionToWriteFlow}` and renders
    // `disabled`), and a brand-new project always shows it — unlike the table's "Create New",
    // which only exists once the project has flows.
    const adminCreate = ownerPage.getByRole('button', { name: 'Start from scratch' }).first();
    await expect(adminCreate).toBeEnabled({ timeout: 30_000 });
    await shot(ownerPage, '06-project-admin-sees-an-enabled-start-from-scratch');

    const viewerContext = await browser.newContext();
    const viewerPage = await acceptInviteAndSignUp(viewerContext, link, {
      firstName: 'View',
      lastName: 'Only',
      password: 'Viewer12345!',
    });
    await viewerPage.goto(`/projects/${projectId}/automations`);
    await viewerPage.waitForLoadState('networkidle');
    await shot(viewerPage, '07-the-same-page-as-a-viewer');

    // The gate is what this asserts: pre-#325 `checkAccess` was a CE stub returning true, so this
    // control was offered to a Viewer and only failed on click with PERMISSION_DENIED.
    const viewerCreate = viewerPage.getByRole('button', { name: 'Start from scratch' }).first();
    await expect(viewerCreate).toBeVisible({ timeout: 30_000 });
    await expect(
      viewerCreate,
      'a Viewer must not be offered an enabled flow-creation control',
    ).toBeDisabled();

    // The Tables card next to it takes the same treatment from `userHasPermissionToWriteTable`,
    // and a Viewer's role carries READ_TABLE without WRITE_TABLE — so it must be disabled too.
    // Asserted rather than eyeballed: on the frame above the two cards read differently enough
    // to be worth checking, and "it looked greyed out" is not a verification.
    const viewerCreateTable = viewerPage.getByRole('button', { name: 'Start from scratch' }).nth(1);
    await expect(
      viewerCreateTable,
      'a Viewer must not be offered an enabled table-creation control',
    ).toBeDisabled();

    await viewerContext.close();
    await ownerContext.close();
  });

  test('the UI renders in Russian, Uzbek and Kazakh (#304, #237)', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    for (const [index, [label, marker]] of LOCALES.entries()) {
      await openAccountSettings(page);
      await languageCombobox(page).click();
      await page.getByRole('option', { name: label }).click();
      await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });
      await shot(page, `${String(8 + index).padStart(2, '0')}-ui-in-${label}`);
      await page.keyboard.press('Escape');
    }

    // The nine removed locales must not be on offer — that is the other half of #237.
    await openAccountSettings(page);
    await languageCombobox(page).click();
    for (const gone of ['Deutsch', 'Français', 'Español', '日本語', '中文']) {
      await expect(page.getByRole('option', { name: gone })).toHaveCount(0);
    }
    await shot(page, '11-language-list-offers-only-the-four-supported-locales');

    // Back to English, so the next test does not inherit a Kazakh UI. The locale is per-user and
    // persists across reloads, which is the point of the feature and the trap for a serial suite.
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.getByText('Automations').first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
  });

  test('the dark and system themes apply (#300, #313)', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await openAccountSettings(page);
    await selectTheme(page, 'Dark');
    await expect(page.locator('html')).toHaveClass(/dark/, { timeout: 15_000 });
    await shot(page, '12-dark-theme-applied');

    await selectTheme(page, 'Light');
    await expect(page.locator('html')).not.toHaveClass(/dark/, { timeout: 15_000 });
    await shot(page, '13-light-theme-applied');

    // `system` must follow the OS preference, not fall back to a fixed value — the #300 defect.
    await selectTheme(page, 'System');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/, { timeout: 15_000 });
    await shot(page, '14-system-theme-follows-the-os-into-dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/, { timeout: 15_000 });
    await shot(page, '15-system-theme-follows-the-os-back-to-light');
  });
});

async function openAccountSettings(page: Page): Promise<void> {
  if (!page.url().includes('/automations')) {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');
  }
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    return;
  }
  // The dropdown trigger is a `SidebarMenuButton` with no test id. It is the LAST button in the
  // sidebar footer — a platform admin also gets a "Platform Admin" button above it, so `.first()`
  // silently opens nothing and the menu never appears.
  await page.locator('[data-sidebar="footer"] button').last().click();
  await page.getByRole('menuitem', { name: /Account Settings|Настройки|Sozlamalar|Параметрлер/i }).click();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
}

// Account Settings renders ThemeToggle above LanguageToggle, and both triggers expose
// role="combobox" — index, not order-of-appearance guesswork, is what keeps these apart.
function languageCombobox(page: Page) {
  return page.getByRole('dialog').getByRole('combobox').nth(1);
}

async function selectTheme(page: Page, name: string): Promise<void> {
  await openAccountSettings(page);
  await page.getByRole('dialog').getByRole('combobox').nth(0).click();
  // Light / Dark / System are hardcoded English in theme-toggle.tsx, not translated, so this
  // works whatever locale the previous test left behind.
  await page.getByRole('option', { name, exact: true }).click();
}

async function messageCount(page: Page, mailpit: string): Promise<number> {
  const res = await page.request.get(`${mailpit}/api/v1/messages`);
  return ((await res.json()) as { messages_count: number }).messages_count;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = path.resolve(__dirname, '../../../screenshots/v2-acceptance');
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

// Marker = this locale's own translation of "Automations", read from
// packages/web/public/locales/<code>/translation.json rather than typed from memory.
const LOCALES: [string, string][] = [
  ['Русский', 'Автоматизации'],
  ["O'zbek", 'Avtomatlashtirishlar'],
  ['Қазақша', 'Автоматтандырулар'],
];
