import {
  AuthenticationResponse,
  ErrorCode,
  isNil,
  LdapSignInRequest,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { ArrowLeft } from 'lucide-react';
import { useForm } from 'react-hook-form';

import { authenticationApi } from '@/api/authentication-api';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { HttpError, api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';
import { useRedirectAfterLogin } from '@/lib/navigation-utils';

type LdapLoginFormProps = {
  onBack: () => void;
};

export const LdapLoginForm = ({ onBack }: LdapLoginFormProps) => {
  const redirectAfterLogin = useRedirectAfterLogin();

  const form = useForm<LdapSignInRequest>({
    resolver: zodResolver(LdapSignInRequest),
    defaultValues: { username: '', password: '' },
    mode: 'onChange',
  });

  const { mutate, isPending } = useMutation<
    AuthenticationResponse,
    HttpError,
    LdapSignInRequest
  >({
    mutationFn: authenticationApi.ldapSignIn,
    onSuccess: (data) => {
      authenticationSession.saveResponse(data, false);
      redirectAfterLogin();
    },
    onError: (error) => {
      form.setError('root.serverError', {
        message: resolveLdapSignInErrorMessage(error),
      });
    },
  });

  return (
    <Form {...form}>
      <form
        className="grid space-y-4"
        onSubmit={form.handleSubmit((data) => {
          form.clearErrors('root.serverError');
          mutate(data);
        })}
      >
        <p className="text-sm text-muted-foreground">
          {t('Sign in with your directory username and password.')}
        </p>
        <FormField
          name="username"
          render={({ field }) => (
            <FormItem className="grid space-y-2">
              <FormLabel htmlFor="ldapUsername">{t('Username')}</FormLabel>
              <Input
                {...field}
                id="ldapUsername"
                type="text"
                autoFocus
                autoComplete="username"
                className="rounded-sm"
                data-testid="ldap-sign-in-username"
              />
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name="password"
          render={({ field }) => (
            <FormItem className="grid space-y-2">
              <FormLabel htmlFor="ldapPassword">{t('Password')}</FormLabel>
              <Input
                {...field}
                id="ldapPassword"
                type="password"
                autoComplete="current-password"
                className="rounded-sm"
                data-testid="ldap-sign-in-password"
              />
              <FormMessage />
            </FormItem>
          )}
        />
        {form.formState.errors.root?.serverError && (
          <FormMessage>
            {form.formState.errors.root.serverError.message}
          </FormMessage>
        )}
        <Button
          type="submit"
          loading={isPending}
          disabled={!form.formState.isValid}
          data-testid="ldap-sign-in-button"
        >
          {t('Sign in')}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('Back to sign in')}
        </Button>
      </form>
    </Form>
  );
};

function resolveLdapSignInErrorMessage(error: HttpError): string {
  if (!api.isError(error)) {
    return t('Something went wrong, please try again later');
  }
  if (error.response?.status === api.httpStatus.TooManyRequests) {
    return t('Too many attempts. Please wait a minute and try again.');
  }
  const errorCode: ErrorCode | undefined = (
    error.response?.data as { code: ErrorCode }
  )?.code;
  if (isNil(errorCode)) {
    return t('Something went wrong, please try again later');
  }
  switch (errorCode) {
    case ErrorCode.LDAP_DIRECTORY_UNREACHABLE:
      return t(
        'The directory is unavailable right now. Contact your administrator.',
      );
    case ErrorCode.LDAP_BIND_ACCOUNT_REJECTED:
      return t(
        'The directory connection is misconfigured. Contact your administrator.',
      );
    case ErrorCode.LDAP_EMAIL_ATTRIBUTE_MISSING:
      return t(
        'Your directory account has no email address on file. Contact your administrator.',
      );
    case ErrorCode.LDAP_ACCOUNT_COLLISION:
      return t(
        'An account with this email already exists and is not linked to the directory. Contact your administrator.',
      );
    case ErrorCode.USER_IS_INACTIVE:
      return t('User has been deactivated');
    case ErrorCode.INVALID_CREDENTIALS:
      return t('Invalid username or password');
    default:
      return t('Something went wrong, please try again later');
  }
}
