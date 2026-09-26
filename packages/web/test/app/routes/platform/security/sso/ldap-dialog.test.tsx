// @vitest-environment jsdom
import {
  FilteredQadamBehavior,
  LdapTlsMode,
  PlatformLdapConfig,
  PlatformWithoutSensitiveData,
  TeamProjectsLimit,
  UpsertLdapConfigRequest,
} from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConfigureLdapDialog } from '@/app/routes/platform/security/sso/ldap-dialog';

const OWNER_ID = 'owner1';

let capturedSaveRequest: UpsertLdapConfigRequest | undefined;

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => OWNER_ID },
}));

vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: {
    useWebsiteBranding: () => ({
      websiteName: 'Test Flow',
      logos: { fullLogoUrl: '', favIconUrl: '', logoIconUrl: '' },
      colors: { primary: { default: '', dark: '', light: '' } },
    }),
  },
}));

vi.mock('@/features/platform-admin', () => ({
  ldapConfigApi: { delete: vi.fn() },
  ldapConfigKeys: { all: ['ldap-config'] },
  ldapConfigMutations: {
    useUpsertLdapConfig: () => ({
      mutate: (request: UpsertLdapConfigRequest) => {
        capturedSaveRequest = request;
      },
      isPending: false,
    }),
    useTestLdapConfig: () => ({
      mutate: vi.fn(),
      isPending: false,
      data: undefined,
    }),
  },
}));

const PLATFORM: PlatformWithoutSensitiveData = {
  federatedAuthProviders: null,
  plan: {
    plan: null,
    tablesEnabled: false,
    eventStreamingEnabled: false,
    environmentsEnabled: false,
    analyticsEnabled: false,
    showPoweredBy: false,
    auditLogEnabled: false,
    embeddingEnabled: false,
    agentsEnabled: false,
    aiProvidersEnabled: false,
    chatEnabled: false,
    dataManipulationEnabled: false,
    managePiecesEnabled: false,
    manageTemplatesEnabled: false,
    customAppearanceEnabled: false,
    teamProjectsLimit: TeamProjectsLimit.UNLIMITED,
    projectRolesEnabled: false,
    globalConnectionsEnabled: false,
    customRolesEnabled: false,
    ssoEnabled: false,
    secretManagersEnabled: false,
    scimEnabled: false,
    licenseKey: null,
    licenseExpiresAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    stripeSubscriptionStartDate: null,
    stripeSubscriptionEndDate: null,
    stripeSubscriptionCancelDate: null,
    projectsLimit: null,
    activeFlowsLimit: null,
    dedicatedWorkers: null,
    canary: false,
    customDomainsEnabled: false,
    workerGroupId: null,
  },
  id: 'platform1',
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  ownerId: OWNER_ID,
  name: 'Test Platform',
  primaryColor: '#000000',
  logoIconUrl: '',
  fullLogoUrl: '',
  favIconUrl: '',
  filteredQadamNames: [],
  filteredQadamBehavior: FilteredQadamBehavior.BLOCKED,
  googleAuthEnabled: false,
  enforceAllowedAuthDomains: false,
  allowedAuthDomains: [],
  allowedEmbedOrigins: [],
  ssoDomain: null,
  ssoDomainVerification: null,
  emailAuthEnabled: true,
  pinnedQadams: [],
};

const LDAP_CONFIG: PlatformLdapConfig = {
  id: 'ldap-config1',
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  platformId: 'platform1',
  config: {
    url: 'ldaps://dc.acme.com:636',
    tlsMode: LdapTlsMode.LDAPS,
    baseDn: 'dc=acme,dc=com',
    bindDn: 'cn=svc-qadam-flow,dc=acme,dc=com',
    userFilter: '(uid={username})',
    attributeMap: {
      subject: 'entryUUID',
      email: 'mail',
      firstName: 'givenName',
      lastName: 'sn',
    },
    tlsVerify: true,
    jitProvisioning: true,
    linkExistingByEmail: false,
    sessionTtlSeconds: 43200,
    enabled: true,
    nestedGroups: false,
    groupMappings: [],
  },
  hasBindPassword: true,
  hasCaCertificate: true,
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const mount = async (): Promise<void> => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ConfigureLdapDialog platform={PLATFORM} config={LDAP_CONFIG} />
      </QueryClientProvider>,
    );
  });
  await flush();
};

const findButtonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );

const click = async (element: Element): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

// A React-controlled input ignores a plain `input.value = …` (React tracks the value through its
// own property descriptor, not the DOM's), so setting through the native setter and dispatching a
// real `input` event is what makes `onChange` actually fire — same trick the AI model selector's
// own combobox test already uses.
const typeInto = async (
  input: HTMLInputElement,
  value: string,
): Promise<void> => {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!valueSetter) {
    throw new Error('HTMLInputElement has no value setter');
  }
  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};

const inputById = (id: string): HTMLInputElement => {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`no input#${id}`);
  }
  return input;
};

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
  capturedSaveRequest = undefined;
});

describe('ConfigureLdapDialog — empty-secret regression (the "" bug)', () => {
  it('clicking Remove on the CA certificate, then saving, sends caCertificate: null — not ""', async () => {
    await mount();
    await click(findButtonByText('Edit')!);

    await click(findButtonByText('Remove')!);
    await typeInto(inputById('bindPassword'), 'a-fresh-bind-password');
    await click(findButtonByText('Save')!);

    expect(capturedSaveRequest).toBeDefined();
    expect(capturedSaveRequest?.caCertificate).toBeNull();
  });

  it('typing into Bind password then clearing it, editing Base DN, and saving sends bindPassword: undefined — not ""', async () => {
    await mount();
    await click(findButtonByText('Edit')!);

    const bindPassword = inputById('bindPassword');
    await typeInto(bindPassword, 'temporary-typo');
    await typeInto(bindPassword, '');
    await typeInto(inputById('baseDn'), 'dc=new,dc=acme,dc=com');
    await click(findButtonByText('Save')!);

    expect(capturedSaveRequest).toBeDefined();
    expect(capturedSaveRequest?.bindPassword).toBeUndefined();
    expect(capturedSaveRequest?.baseDn).toBe('dc=new,dc=acme,dc=com');
  });
});
