import path from 'path';

import { faker } from '@faker-js/faker';
import { test, expect } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  acceptInviteAndSignUp,
  createTeamProjectViaUI,
  inviteMemberViaTeamTab,
  issuePlatformMemberInvite,
  memberRow,
  openTeamTab,
  signIn,
} from './member-helpers';

const SHOTS = path.resolve(__dirname, '../../../screenshots/failure-alerts');

// #88: a non-platform-admin, as ADMIN of a team project they created, arms per-member
// flow-failure email alerts from the Team tab — for themselves and for an invited member —
// entirely through the UI. Requires SMTP configured on the backend (otherwise the toggle is
// disabled with a hint); this runs against a dev stack booted with AP_SMTP_* set.
test.describe('Per-member failure alerts toggle (#88, UI)', () => {
  test.setTimeout(180_000);

  test('non-admin owner enables failure alerts for themselves and an invited member — via clicks', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `owner2+${suffix}@example.com`;
    const memberEmail = `member+${suffix}@example.com`;
    const projectName = `E2E ${suffix} ${faker.animal.bird()}`;

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ownerInviteLink = await issuePlatformMemberInvite(page, ownerEmail);

    const ownerCtx = await browser.newContext();
    const owner = await acceptInviteAndSignUp(ownerCtx, ownerInviteLink, {
      firstName: 'Nadia',
      lastName: 'NonAdmin',
      password: OWNER_PASSWORD,
    });

    await createTeamProjectViaUI(owner, projectName);
    await owner.waitForLoadState('networkidle');
    let dialog = await openTeamTab(owner);

    // SMTP is configured → no hint, toggles enabled.
    await expect(
      dialog.getByText('Failure alerts require email (SMTP) to be configured for this platform.'),
    ).toHaveCount(0);

    // Phase 1: enable failure alerts for owner2 themselves.
    const ownerToggle = memberRow(dialog, ownerEmail).getByRole('switch');
    await expect(ownerToggle).toBeEnabled();
    await expect(ownerToggle).not.toBeChecked();
    const ownerAlert = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/alerts') && r.request().method() === 'POST',
    );
    await ownerToggle.click();
    expect((await ownerAlert).status()).toBeLessThan(300);
    await expect(ownerToggle).toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/01-owner-alerts-on.png`, fullPage: true });

    // Phase 2: invite a member from the Team tab; member accepts + signs up via the invite link.
    const memberInviteLink = await inviteMemberViaTeamTab(owner, dialog, memberEmail);
    await expect(dialog.getByText(memberEmail)).toBeVisible({ timeout: 10_000 });
    await owner.screenshot({ path: `${SHOTS}/02-member-invited-pending.png`, fullPage: true });

    const memberCtx = await browser.newContext();
    await acceptInviteAndSignUp(memberCtx, memberInviteLink, {
      firstName: 'Marat',
      lastName: 'Member',
      password: MEMBER_PASSWORD,
    });
    await memberCtx.close();

    // Phase 3: owner2 reopens the Team tab and enables the invited member's alerts too.
    await owner.reload();
    await owner.waitForLoadState('networkidle');
    dialog = await openTeamTab(owner);
    const memberToggle = memberRow(dialog, memberEmail).getByRole('switch');
    await expect(memberToggle).toBeVisible({ timeout: 10_000 });
    await expect(memberToggle).toBeEnabled();
    await expect(memberToggle).not.toBeChecked();
    const memberAlert = owner.waitForResponse(
      (r) => r.url().includes('/api/v1/alerts') && r.request().method() === 'POST',
    );
    await memberToggle.click();
    expect((await memberAlert).status()).toBeLessThan(300);
    await expect(memberToggle).toBeChecked();
    // Owner's alert persisted across the reload above (its checked state is re-derived from a
    // fresh alerts fetch), and the member's alert is on — both confirmed purely from the UI.
    await expect(memberRow(dialog, ownerEmail).getByRole('switch')).toBeChecked();
    await owner.screenshot({ path: `${SHOTS}/03-both-members-alerts-on.png`, fullPage: true });

    await ownerCtx.close();
  });
});
