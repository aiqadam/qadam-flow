import { LdapTlsMode, UpsertLdapConfigRequest } from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';

import { ldapConfigFormUtils } from '@/app/routes/platform/security/sso/ldap-config-form-helpers';

const baseValues: UpsertLdapConfigRequest = {
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
};

describe('ldapConfigFormUtils.buildUpsertLdapConfigRequest', () => {
  it('sends caCertificate: null when the operator clicked Remove, regardless of the field value', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, caCertificate: 'stale-leftover-text' },
      clearCaCertificate: true,
    });

    expect(request.caCertificate).toBeNull();
  });

  it('omits a typed-then-cleared CA certificate (undefined) instead of sending an empty string', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, caCertificate: undefined },
      clearCaCertificate: false,
    });

    expect(request.caCertificate).toBeUndefined();
  });

  it('sends a non-empty CA certificate through unchanged', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, caCertificate: '-----BEGIN CERTIFICATE-----' },
      clearCaCertificate: false,
    });

    expect(request.caCertificate).toBe('-----BEGIN CERTIFICATE-----');
  });

  it('treats an empty-string CA certificate the same as an absent one (never sends "")', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, caCertificate: '' },
      clearCaCertificate: false,
    });

    expect(request.caCertificate).toBeUndefined();
  });

  it('omits a typed-then-cleared bind password (undefined) instead of sending an empty string', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, bindPassword: undefined },
      clearCaCertificate: false,
    });

    expect(request.bindPassword).toBeUndefined();
  });

  it('sends the bind password exactly as typed, without trimming', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, bindPassword: '  leading and trailing  ' },
      clearCaCertificate: false,
    });

    expect(request.bindPassword).toBe('  leading and trailing  ');
  });

  it('treats an empty-string bind password the same as an absent one (never sends "")', () => {
    const request = ldapConfigFormUtils.buildUpsertLdapConfigRequest({
      values: { ...baseValues, bindPassword: '' },
      clearCaCertificate: false,
    });

    expect(request.bindPassword).toBeUndefined();
  });
});

describe('ldapConfigFormUtils.computeBindPasswordConfirmationRequired', () => {
  it('is never required in create mode, no matter what is dirty', () => {
    const required =
      ldapConfigFormUtils.computeBindPasswordConfirmationRequired({
        isEditMode: false,
        clearCaCertificate: true,
        dirtyFields: { url: true, bindDn: true },
      });

    expect(required).toBe(false);
  });

  it('is not required in edit mode when nothing connection-sensitive changed', () => {
    const required =
      ldapConfigFormUtils.computeBindPasswordConfirmationRequired({
        isEditMode: true,
        clearCaCertificate: false,
        dirtyFields: { baseDn: true, userFilter: true },
      });

    expect(required).toBe(false);
  });

  it('is required in edit mode when the CA certificate was cleared', () => {
    const required =
      ldapConfigFormUtils.computeBindPasswordConfirmationRequired({
        isEditMode: true,
        clearCaCertificate: true,
        dirtyFields: {},
      });

    expect(required).toBe(true);
  });

  it.each(['url', 'bindDn', 'tlsVerify', 'tlsMode', 'caCertificate'] as const)(
    'is required in edit mode when %s changed',
    (fieldName) => {
      const required =
        ldapConfigFormUtils.computeBindPasswordConfirmationRequired({
          isEditMode: true,
          clearCaCertificate: false,
          dirtyFields: { [fieldName]: true },
        });

      expect(required).toBe(true);
    },
  );

  it('is not required in edit mode when only an unrelated field changed', () => {
    const required =
      ldapConfigFormUtils.computeBindPasswordConfirmationRequired({
        isEditMode: true,
        clearCaCertificate: false,
        dirtyFields: { enabled: true },
      });

    expect(required).toBe(false);
  });
});

describe('ldapConfigFormUtils.computeFormLockedForNonOwner', () => {
  it('locks the form for a non-owner while linking is on', () => {
    expect(
      ldapConfigFormUtils.computeFormLockedForNonOwner({
        isOwner: false,
        linkExistingByEmail: true,
      }),
    ).toBe(true);
  });

  it('never locks the form for the owner, even while linking is on', () => {
    expect(
      ldapConfigFormUtils.computeFormLockedForNonOwner({
        isOwner: true,
        linkExistingByEmail: true,
      }),
    ).toBe(false);
  });

  it('does not lock a non-owner when linking is off', () => {
    expect(
      ldapConfigFormUtils.computeFormLockedForNonOwner({
        isOwner: false,
        linkExistingByEmail: false,
      }),
    ).toBe(false);
  });
});

describe('ldapConfigFormUtils.isBindPasswordRequiredButMissing', () => {
  it('is missing in create mode with a blank password', () => {
    expect(
      ldapConfigFormUtils.isBindPasswordRequiredButMissing({
        isEditMode: false,
        bindPasswordConfirmationRequired: false,
        bindPassword: undefined,
      }),
    ).toBe(true);
  });

  it('is missing in edit mode when confirmation is required and the password is blank', () => {
    expect(
      ldapConfigFormUtils.isBindPasswordRequiredButMissing({
        isEditMode: true,
        bindPasswordConfirmationRequired: true,
        bindPassword: '',
      }),
    ).toBe(true);
  });

  it('is not missing in edit mode when confirmation is not required, even with a blank password', () => {
    expect(
      ldapConfigFormUtils.isBindPasswordRequiredButMissing({
        isEditMode: true,
        bindPasswordConfirmationRequired: false,
        bindPassword: undefined,
      }),
    ).toBe(false);
  });

  it('is not missing once a password is present', () => {
    expect(
      ldapConfigFormUtils.isBindPasswordRequiredButMissing({
        isEditMode: false,
        bindPasswordConfirmationRequired: false,
        bindPassword: 'correct horse battery staple',
      }),
    ).toBe(false);
  });
});
