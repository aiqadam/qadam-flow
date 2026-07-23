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
  issuePlatformMemberInvite,
  memberRow,
  openTeamTab,
  signIn,
} from './member-helpers';

const SHOTS = path.resolve(__dirname, '../../../screenshots/team-collaboration');

// Golden path driven entirely through the UI, from the perspective that actually matters:
// a NON-platform-admin who creates a team project manages its members from project settings
// (never touching /platform, which is admin-gated). Screenshots are captured at every step so
// the sequence reads as a visual walkthrough of the whole process. The only non-UI step is the
// admin issuing the initial platform invite that mints the non-admin actor — there is no UI for it.
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

    let step = 0;
    const shot = async (p: Page, name: string) => {
      step += 1;
      await p.screenshot({
        path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`,
        fullPage: true,
      });
    };

    // Admin mints the non-admin actor (only non-UI step).
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ownerInviteLink = await issuePlatformMemberInvite(page, ownerEmail);

    // owner2 enters like a real user: opens the invite link → accepts → signs up.
    const ownerCtx = await browser.newContext();
    const owner = await acceptInviteAndSignUp(
      ownerCtx,
      ownerInviteLink,
      { firstName: 'Nadia', lastName: 'NonAdmin', password: OWNER_PASSWORD },
      shot,
    );
    await shot(owner, 'owner-dashboard-non-admin');

    // Non-admin: /platform is admin-gated and redirects away.
    await owner.goto('/platform/projects');
    await owner.waitForURL((u) => !u.pathname.startsWith('/platform'), { timeout: 10_000 });
    await shot(owner, 'blocked-from-platform');

    // owner2 creates a team project from the sidebar (becomes its project ADMIN).
    await createTeamProjectViaUI(owner, projectName, shot);
    await shot(owner, 'team-project-created');

    // owner2 opens Settings → Team and invites a member.
    let dialog = await openTeamTab(owner);
    await shot(owner, 'team-tab-opened');
    const memberInviteLink = await inviteMemberViaTeamTab(owner, dialog, memberEmail);
    await expect(dialog.getByText(memberEmail)).toBeVisible({ timeout: 10_000 });
    await shot(owner, 'member-invited-pending');

    // The invitee enters via the invite link and signs up.
    const memberCtx = await browser.newContext();
    await acceptInviteAndSignUp(
      memberCtx,
      memberInviteLink,
      { firstName: 'Marat', lastName: 'Member', password: MEMBER_PASSWORD },
      shot,
    );
    await memberCtx.close();

    // owner2 (non-admin) reopens the Team tab and sees the ACCEPTED member listed.
    await owner.reload();
    await owner.waitForLoadState('networkidle');
    dialog = await openTeamTab(owner);
    const row = memberRow(dialog, memberEmail);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('switch')).toBeVisible();
    await shot(owner, 'non-admin-sees-accepted-member');

    await ownerCtx.close();
  });
});
