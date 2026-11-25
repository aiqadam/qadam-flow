import {
  AuthenticationResponse,
  CreateOtpRequestBody,
  isNil,
  ResetPasswordRequestBody,
  SignInRequest,
  SignInResponse,
  SignUpRequest,
  UserIdentity,
  VerifyEmailRequestBody,
} from '@aiqadam/shared';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';

import { authenticationApi } from '@/api/authentication-api';
import { HttpError } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';
import { useRedirectAfterLogin } from '@/lib/navigation-utils';

export const authMutations = {
  useSignIn: ({
    onSuccess,
    onError,
  }: {
    onSuccess: (data: SignInResponse) => void;
    onError: (error: HttpError) => void;
  }) => {
    return useMutation<SignInResponse, HttpError, SignInRequest>({
      mutationFn: authenticationApi.signIn,
      onSuccess,
      onError,
    });
  },
  useSignUp: ({
    onSuccess,
    onError,
  }: {
    onSuccess: (data: AuthenticationResponse) => void;
    onError: (error: HttpError) => void;
  }) => {
    return useMutation<AuthenticationResponse, HttpError, SignUpRequest>({
      mutationFn: authenticationApi.signUp,
      onSuccess,
      onError,
    });
  },
  useSendOtpEmail: ({ onSuccess }: { onSuccess?: () => void }) => {
    return useMutation<void, HttpError, CreateOtpRequestBody>({
      mutationFn: authenticationApi.sendOtpEmail,
      onSuccess,
    });
  },
  useResetPassword: ({
    onSuccess,
    onError,
  }: {
    onSuccess: () => void;
    onError: (error: HttpError) => void;
  }) => {
    return useMutation<void, HttpError, ResetPasswordRequestBody>({
      mutationFn: authenticationApi.resetPassword,
      onSuccess,
      onError,
    });
  },
  useVerifyEmail: ({
    onSuccess,
    onError,
  }: {
    onSuccess: (data: UserIdentity) => void;
    onError: (error: unknown) => void;
  }) => {
    return useMutation({
      mutationFn: (request: VerifyEmailRequestBody) =>
        authenticationApi.verifyEmail(request),
      onSuccess,
      onError,
    });
  },
};

// Shared by every path that ends a sign-in with a real session — the normal sign-in success
// handler, the MFA challenge, and forced/self-service MFA enrolment all adopt an
// `AuthenticationResponse` the same way.
export const useCompleteSignIn = () => {
  const navigate = useNavigate();
  const redirectAfterLogin = useRedirectAfterLogin();
  return (response: AuthenticationResponse) => {
    authenticationSession.saveResponse(response, false);
    if (isNil(response.projectId)) {
      navigate('/create-platform');
      return;
    }
    redirectAfterLogin();
  };
};
