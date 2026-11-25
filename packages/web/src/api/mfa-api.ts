import {
  AuthenticationResponse,
  MfaEnrollmentConfirmAuthenticatedRequest,
  MfaEnrollmentConfirmRequest,
  MfaEnrollmentConfirmResponse,
  MfaEnrollmentConfirmWithSessionResponse,
  MfaEnrollmentStartRequest,
  MfaEnrollmentStartResponse,
  MfaReauthenticationRequest,
  MfaRecoveryCodesResponse,
  MfaStatusResponse,
  MfaVerifyRequest,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

export const mfaApi = {
  verifyChallenge(request: MfaVerifyRequest) {
    return api.post<AuthenticationResponse>(
      '/v1/mfa/challenge/verify',
      request,
    );
  },
  startPendingEnrollment(request: MfaEnrollmentStartRequest) {
    return api.post<MfaEnrollmentStartResponse>(
      '/v1/mfa/enroll/pending/start',
      request,
    );
  },
  confirmPendingEnrollment(request: MfaEnrollmentConfirmRequest) {
    return api.post<MfaEnrollmentConfirmWithSessionResponse>(
      '/v1/mfa/enroll/pending/confirm',
      request,
    );
  },
  getStatus() {
    return api.get<MfaStatusResponse>('/v1/mfa/status');
  },
  startEnrollment(request: MfaReauthenticationRequest) {
    return api.post<MfaEnrollmentStartResponse>(
      '/v1/mfa/enroll/start',
      request,
    );
  },
  confirmEnrollment(request: MfaEnrollmentConfirmAuthenticatedRequest) {
    return api.post<MfaEnrollmentConfirmResponse>(
      '/v1/mfa/enroll/confirm',
      request,
    );
  },
  disable(request: MfaReauthenticationRequest) {
    return api.post<AuthenticationResponse>('/v1/mfa/disable', request);
  },
  regenerateRecoveryCodes(request: MfaReauthenticationRequest) {
    return api.post<MfaRecoveryCodesResponse>(
      '/v1/mfa/recovery-codes/regenerate',
      request,
    );
  },
};
