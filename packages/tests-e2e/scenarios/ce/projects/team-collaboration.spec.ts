import { faker } from '@faker-js/faker';

import { expect, test } from '../../../fixtures';

test.describe('Team project collaboration', () => {
  test('creates team project, sends invitation, user2 accepts and is provisioned', async ({
    page,
    request,
  }) => {
    test.setTimeout(30_000);

    // Wait for sign-in redirect to complete before reading token
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 15_000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // Step 1: Create a team project
    const projectName = `E2E Team ${faker.animal.bird()}`;
    const createRes = await request.post('/api/v1/projects', {
      headers: auth,
      data: {
        displayName: projectName,
        externalId: null,
        metadata: null,
        maxConcurrentJobs: null,
      },
    });
    expect(createRes.status()).toBe(201);
    const project = await createRes.json();
    expect(project.type).toBe('TEAM');
    expect(project.displayName).toBe(projectName);

    // Step 2: Team project appears in the list
    const listRes = await request.get('/api/v1/projects', { headers: auth });
    expect(listRes.ok()).toBeTruthy();
    const projectsList = await listRes.json();
    const found = projectsList.data?.find(
      (p: { id: string }) => p.id === project.id,
    );
    expect(found).toBeDefined();

    // Step 3: Invite user2 (does not exist yet → invitation stays PENDING with link)
    const user2Email = faker.internet.email();
    const inviteRes = await request.post('/api/v1/user-invitations', {
      headers: auth,
      data: {
        email: user2Email,
        type: 'PROJECT',
        projectId: project.id,
        projectRole: 'Editor',
      },
    });
    expect(inviteRes.status()).toBe(201);
    const invitation: { status: string; link?: string } = await inviteRes.json();
    expect(invitation.status).toBe('PENDING');
    expect(invitation.link).toBeTruthy();
    if (!invitation.link) throw new Error('invitation.link missing');

    // Step 4: Accept the invitation via the public endpoint (simulating user2 clicking the link)
    const invitationToken = new URL(invitation.link).searchParams.get('token');
    expect(invitationToken).toBeTruthy();

    const acceptRes = await request.post('/api/v1/user-invitations/accept', {
      data: { invitationToken },
    });
    expect(acceptRes.status()).toBe(200);

    // Step 5: Invitation is consumed — no longer in the pending list
    const pendingRes = await request.get(
      `/api/v1/user-invitations?type=PROJECT&projectId=${project.id}`,
      { headers: auth },
    );
    expect(pendingRes.ok()).toBeTruthy();
    const pendingList = await pendingRes.json();
    const stillPending = pendingList.data?.find(
      (i: { email: string }) => i.email === user2Email,
    );
    expect(stillPending).toBeUndefined();
  });

  test('uninvited user cannot see another platform team project', async ({
    page,
    request,
    users,
  }) => {
    test.setTimeout(30_000);

    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 15_000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // User1 creates a team project
    const createRes = await request.post('/api/v1/projects', {
      headers: auth,
      data: {
        displayName: `E2E Private ${faker.animal.fish()}`,
        externalId: null,
        metadata: null,
        maxConcurrentJobs: null,
      },
    });
    expect(createRes.status()).toBe(201);
    const teamProject = await createRes.json();

    // User2 signs up on a completely separate platform
    const user2 = await users.apiSignUp();
    const user2Auth = { Authorization: `Bearer ${user2.token}` };

    // User2 cannot see user1's team project
    const listRes = await request.get('/api/v1/projects', { headers: user2Auth });
    expect(listRes.ok()).toBeTruthy();
    const user2Projects = await listRes.json();
    const illegalAccess = user2Projects.data?.find(
      (p: { id: string }) => p.id === teamProject.id,
    );
    expect(illegalAccess).toBeUndefined();
  });
});
