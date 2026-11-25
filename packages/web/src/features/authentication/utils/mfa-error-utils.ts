import { ErrorCode } from '@aiqadam/shared';
import { t } from 'i18next';

import { HttpError, api } from '@/lib/api';

function resolveMfaErrorMessage(error: HttpError): string {
  if (!api.isError(error)) {
    return t('Something went wrong, please try again later');
  }
  if (error.response?.status === api.httpStatus.TooManyRequests) {
    return t('Too many attempts. Wait and try again.');
  }
  const errorCode = (error.response?.data as { code?: ErrorCode } | undefined)
    ?.code;
  switch (errorCode) {
    case ErrorCode.MFA_INVALID_CODE:
      return t('That code is incorrect. Try again.');
    case ErrorCode.MFA_TOO_MANY_ATTEMPTS:
      return t('Too many attempts. Wait and try again.');
    case ErrorCode.MFA_CHALLENGE_INVALID:
      return t('Your sign-in session has expired. Go back and sign in again.');
    case ErrorCode.MFA_NOT_ENROLLED:
      return t('Two-factor authentication is not set up for this account.');
    case ErrorCode.MFA_ALREADY_ENROLLED:
      return t(
        'Two-factor authentication is already set up for this account.',
      );
    case ErrorCode.INVALID_CREDENTIALS:
      return t('Incorrect password.');
    default:
      return t('Something went wrong, please try again later');
  }
}

export const mfaErrorUtils = { resolveMfaErrorMessage };
