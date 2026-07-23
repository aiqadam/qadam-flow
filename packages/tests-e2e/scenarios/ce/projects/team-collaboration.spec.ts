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

const SHOTS = path.resolve(__dirname, '../../../screenshots/team-collaboration');

// Golden path driven entirely through the UI, from the perspective that actually matters:
// a NON-platform-admin who creates a team project manages its members from project settings
// (never touching /platform, which is admin-gated). The only non-UI step is the admin issuing
// the initial platform invite that mints the non-admin actor — there is no UI for that.
test.describe('Non-admin project owner manages team members (UI)', () => {
  test.setTimeout(150_000);

  test('non-admin creates a team project, invites a member, and sees them accepted — all via clicks', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `owner2+${suffix}@example.com`;
    const memberEmail = `member+${suffix}@example.com`;
    const projectName = `E2E ${suffix} ${faker.animal.bird()}`;

    // Admin mints the non-admin actor (only non-UI step).
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ownerInviteLink = await issuePlatformMemberInvite(page, ownerEmail);

    // owner2 enters like a real user: opens the invite link → accepts → signs up.
    const ownerCtx = await browser.newContext();
    const owner = await acceptInviteAndSignUp(ownerCtx, ownerInviteLink, {
      firstName: 'Nadia',
      lastName: 'NonAdmin',
      password: OWNER_PASSWORD,
    });
    await owner.screenshot({ path: `${SHOTS}/01-nonadmin-signed-up.png`, fullPage: true });

    // Non-admin: /platform is admin-gated and redirects away.
    await owner.goto('/platform/projects');
    await owner.waitForURL((u) => !u.pathname.startsWith('/platform'), { timeout: 10_000 });
    await owner.screenshot({ path: `${SHOTS}/02-nonadmin-blocked-from-platform.png`, fullPage: true });

    // owner2 creates a team project from the sidebar (becomes its project ADMIN).
    // createTeamProjectViaUI leaves us on the new project's page with it selected.
    await createTeamProjectViaUI(owner, projectName);
    await owner.waitForLoadState('networkidle');
    await owner.screenshot({ path: `${SHOTS}/03-team-project-created.png`, fullPage: true });

    // owner2 opens Settings → Team and invites a member.
    let dialog = await openTeamTab(owner);
    const memberInviteLink = await inviteMemberViaTeamTab(owner, dialog, memberEmail);
    await expect(dialog.getByText(memberEmail)).toBeVisible({ timeout: 10_000 });
    await owner.screenshot({ path: `${SHOTS}/04-invite-sent-pending.png`, fullPage: true });

    // The invitee enters via the invite link and signs up.
    const memberCtx = await browser.newContext();
    await acceptInviteAndSignUp(memberCtx, memberInviteLink, {
      firstName: 'Marat',
      lastName: 'Member',
      password: MEMBER_PASSWORD,
    });
    await memberCtx.close();

    // owner2 (non-admin) reopens the Team tab and sees the ACCEPTED member listed.
    await owner.reload();
    await owner.waitForLoadState('networkidle');
    dialog = await openTeamTab(owner);
    const row = memberRow(dialog, memberEmail);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('switch')).toBeVisible();
    await owner.screenshot({ path: `${SHOTS}/05-nonadmin-sees-member-list.png`, fullPage: true });

    await ownerCtx.close();
  });
});
