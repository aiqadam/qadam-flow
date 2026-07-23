import path from 'path';

import { faker } from '@faker-js/faker';
import { test, expect, type Page } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  acceptInviteAndSignUp,
  createTeamProjectViaUI,
  inviteMemberViaTeamTab,
  issuePlatformMemberInviteViaUI,
  memberRow,
  openTeamTab,
  signIn,
} from './member-helpers';

const SHOTS = path.resolve(__dirname, '../../../screenshots/failure-alerts');

// #88: a non-platform-admin, as ADMIN of a team project they created, arms per-member
// flow-failure email alerts from the Team tab — for themselves and for an invited member —
// entirely through the UI, with a screenshot at each step. Requires SMTP configured on the
// backend (otherwise the toggle is disabled with a hint); runs against a dev stack with AP_SMTP_*.
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

    let step = 0;
    const shot = async (p: Page, name: string) => {
      step += 1;
      await p.screenshot({
        path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`,
        fullPage: true,
      });
    };

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ownerInviteLink = await issuePlatformMemberInviteViaUI(page, ownerEmail, shot);

    const ownerCtx = await browser.newContext();
    const owner = await acceptInviteAndSignUp(
      ownerCtx,
      ownerInviteLink,
      { firstName: 'Nadia', lastName: 'NonAdmin', password: OWNER_PASSWORD },
      shot,
    );

    await createTeamProjectViaUI(owner, projectName, shot);
    let dialog = await openTeamTab(owner);

    // SMTP is configured → no hint, toggles enabled.
    await expect(
      dialog.getByText('Failure alerts require email (SMTP) to be configured for this platform.'),
    ).toHaveCount(0);
    await shot(owner, 'team-tab-toggles-enabled');

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
    await shot(owner, 'owner-alerts-on');

    // Phase 2: invite a member from the Team tab; member accepts + signs up via the invite link.
    const memberInviteLink = await inviteMemberViaTeamTab(owner, dialog, memberEmail);
    await expect(dialog.getByText(memberEmail)).toBeVisible({ timeout: 10_000 });
    await shot(owner, 'member-invited-pending');

    const memberCtx = await browser.newContext();
    await acceptInviteAndSignUp(
      memberCtx,
      memberInviteLink,
      { firstName: 'Marat', lastName: 'Member', password: MEMBER_PASSWORD },
      shot,
    );
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
    // Owner's alert persisted across the reload (its checked state is re-derived from a fresh fetch).
    await expect(memberRow(dialog, ownerEmail).getByRole('switch')).toBeChecked();
    await shot(owner, 'both-members-alerts-on');

    await ownerCtx.close();
  });
});
