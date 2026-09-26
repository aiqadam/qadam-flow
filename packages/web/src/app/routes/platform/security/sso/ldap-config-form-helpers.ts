import { UpsertLdapConfigRequest } from '@aiqadam/shared';

export const ldapConfigFormUtils = {
  buildUpsertLdapConfigRequest,
  computeBindPasswordConfirmationRequired,
  computeFormLockedForNonOwner,
  isBindPasswordRequiredButMissing,
};

function buildUpsertLdapConfigRequest({
  values,
  clearCaCertificate,
}: {
  values: LdapFormValues;
  clearCaCertificate: boolean;
}): UpsertLdapConfigRequest {
  return {
    ...values,
    // The stored secret is never re-sent unless the operator actually typed something — an empty
    // string here would violate the shared schema's `.min(1)` and reject the whole save, so a
    // blank field means "leave it alone" (`undefined`), never "clear it" (there is no way to clear
    // the bind password other than deleting the whole config). Sent exactly as typed, not trimmed:
    // a directory password's whitespace is significant, not a typo to correct.
    bindPassword: isBlank(values.bindPassword)
      ? undefined
      : values.bindPassword,
    // A CA certificate has no meaningful whitespace-only value the way a password might, so its
    // emptiness check trims first — pasting a certificate and then selecting-all-and-deleting
    // sometimes leaves a stray newline/space behind, and that should count as blank too.
    caCertificate: clearCaCertificate
      ? null
      : isCaCertificateBlank(values.caCertificate)
      ? undefined
      : values.caCertificate,
  };
}

// Any of these five requires the bind password to be re-entered on save — the server treats them
// as re-authenticating the bind account against the directory, not a cosmetic edit.
const FIELDS_REQUIRING_BIND_PASSWORD_CONFIRMATION = [
  'url',
  'bindDn',
  'tlsVerify',
  'tlsMode',
  'caCertificate',
] as const;

function computeBindPasswordConfirmationRequired({
  isEditMode,
  clearCaCertificate,
  dirtyFields,
}: {
  isEditMode: boolean;
  clearCaCertificate: boolean;
  // Widened to every field on the request, not just the five that matter here — the caller's
  // real value is React Hook Form's `formState.dirtyFields`, which legitimately carries every
  // other field too (and nests object fields like `attributeMap` as sub-objects, not booleans).
  dirtyFields: Partial<Record<keyof UpsertLdapConfigRequest, unknown>>;
}): boolean {
  return (
    isEditMode &&
    (clearCaCertificate ||
      FIELDS_REQUIRING_BIND_PASSWORD_CONFIRMATION.some(
        (name) => dirtyFields[name],
      ))
  );
}

function computeFormLockedForNonOwner({
  isOwner,
  linkExistingByEmail,
}: {
  isOwner: boolean;
  linkExistingByEmail: boolean;
}): boolean {
  return !isOwner && linkExistingByEmail;
}

function isBindPasswordRequiredButMissing({
  isEditMode,
  bindPasswordConfirmationRequired,
  bindPassword,
}: {
  isEditMode: boolean;
  bindPasswordConfirmationRequired: boolean;
  bindPassword: string | undefined;
}): boolean {
  return (
    (!isEditMode || bindPasswordConfirmationRequired) && isBlank(bindPassword)
  );
}

function isBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.length === 0;
}

function isCaCertificateBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

type LdapFormValues = UpsertLdapConfigRequest;
