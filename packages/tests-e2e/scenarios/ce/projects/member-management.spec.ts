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

const SHOTS = path.resolve(__dirname, '../../../screenshots/member-management');

// #738: the project ADMIN can re-role and remove a member from the Team tab — the controls the
// tab previously lacked entirely. Like team-collaboration.spec.ts, this drives the non-admin
// actor that actually needs the surface (a project ADMIN who is a plain platform MEMBER), and
// every assertion is against the DOM.
test.describe('Project admin re-roles and removes a member (UI)', () => {
  test.setTimeout(180_000);

  test('changes a member role and removes the member — all via clicks', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const ownerEmail = `owner3+${suffix}@example.com`;
    const memberEmail = `member2+${suffix}@example.com`;
    const projectName = `E2E members ${suffix} ${faker.animal.bird()}`;

    let step = 0;
    const shot = async (p: Page, name: string) => {
      step += 1;
      await p.screenshot({
        path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`,
        fullPage: true,
      });
    };

    // Admin mints the non-admin actor (the only non-UI step).
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ownerInviteLink = await issuePlatformMemberInviteViaUI(page, ownerEmail);

    const ownerCtx = await browser.newContext();
    const owner = await acceptInviteAndSignUp(ownerCtx, ownerInviteLink, {
      firstName: 'Olzhas',
      lastName: 'Owner',
      password: OWNER_PASSWORD,
    });
    await createTeamProjectViaUI(owner, projectName);

    let dialog = await openTeamTab(owner);
    const memberInviteLink = await inviteMemberViaTeamTab(
      owner,
      dialog,
      memberEmail,
    );

    // The invitee enters via the invite link and signs up, becoming an accepted member.
    const memberCtx = await browser.newContext();
    await acceptInviteAndSignUp(memberCtx, memberInviteLink, {
      firstName: 'Mira',
      lastName: 'Member',
      password: MEMBER_PASSWORD,
    });
    await memberCtx.close();

    await owner.reload();
    await owner.waitForLoadState('networkidle');
    dialog = await openTeamTab(owner);
    const row = memberRow(dialog, memberEmail);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await shot(owner, 'member-listed-with-controls');

    // Re-role: Editor (set at invite time) → Viewer.
    await row.getByRole('combobox').click();
    await owner.getByRole('option', { name: 'Viewer' }).click();
    await expect(owner.getByText('Role updated')).toBeVisible({
      timeout: 10_000,
    });
    await expect(row.getByRole('combobox')).toContainText('Viewer');
    await shot(owner, 'role-changed-to-viewer');

    // Remove: trash button → confirmation dialog → confirm.
    await row.getByRole('button', { name: 'Remove member' }).click();
    const confirm = owner
      .getByRole('dialog')
      .filter({ hasText: 'from this project' });
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(owner.getByText('Member removed')).toBeVisible({
      timeout: 10_000,
    });
    await expect(memberRow(dialog, memberEmail)).toBeHidden({
      timeout: 10_000,
    });
    await shot(owner, 'member-removed');

    await ownerCtx.close();
  });
});
