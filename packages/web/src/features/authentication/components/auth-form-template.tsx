import { ApFlagId, ThirdPartyAuthnProvidersToShowMap } from '@aiqadam/shared';
import { t } from 'i18next';
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useTheme } from '@/components/providers/theme-provider';
import { authenticationSession } from '@/lib/authentication-session';
import { useRedirectAfterLogin } from '@/lib/navigation-utils';

import { HorizontalSeparatorWithText } from '../../../components/ui/separator';
import { flagsHooks } from '../../../hooks/flags-hooks';

import { SamlLoginForm } from './saml-login-form';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { ThirdPartyLogin } from './third-party-logins';

const BottomNote = ({ isSignup }: { isSignup: boolean }) => {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.toString();

  return isSignup ? (
    <div className="mt-6 text-center text-[14px] text-muted-foreground">
      {t('Already have an account?')}
      <Link
        to={`/sign-in?${searchQuery}`}
        className="pl-1 font-medium text-foreground hover:underline transition-all duration-200"
      >
        {t('Sign in')}
      </Link>
    </div>
  ) : (
    <div className="mt-6 text-center text-[14px] text-muted-foreground">
      {t("Don't have an account?")}
      <Link
        to={`/sign-up?${searchQuery}`}
        className="pl-1 font-medium text-foreground hover:underline transition-all duration-200"
      >
        {t('Sign up')}
      </Link>
    </div>
  );
};

const TermsFooter = () => {
  const { data: termsOfServiceUrl } = flagsHooks.useFlag<string>(
    ApFlagId.TERMS_OF_SERVICE_URL,
  );
  const { data: privacyPolicyUrl } = flagsHooks.useFlag<string>(
    ApFlagId.PRIVACY_POLICY_URL,
  );

  if (!termsOfServiceUrl && !privacyPolicyUrl) {
    return null;
  }

  return (
    <div className="text-center text-xs text-muted-foreground">
      {t('By continuing, you agree to our')}
      {termsOfServiceUrl && (
        <Link
          to={termsOfServiceUrl}
          target="_blank"
          className="px-1 text-muted-foreground underline hover:text-primary text-xs transition-all duration-200"
        >
          {t('Terms of Service')}
        </Link>
      )}
      {termsOfServiceUrl && privacyPolicyUrl && t('and')}
      {privacyPolicyUrl && (
        <Link
          to={privacyPolicyUrl}
          target="_blank"
          className="pl-1 text-muted-foreground underline hover:text-primary text-xs transition-all duration-200"
        >
          {t('Privacy Policy')}
        </Link>
      )}
      .
    </div>
  );
};

const AuthSeparator = ({
  isEmailAuthEnabled,
}: {
  isEmailAuthEnabled: boolean;
}) => {
  const { data: thirdPartyAuthProviders } =
    flagsHooks.useFlag<ThirdPartyAuthnProvidersToShowMap>(
      ApFlagId.THIRD_PARTY_AUTH_PROVIDERS_TO_SHOW_MAP,
    );
  const hasThirdPartyLogin =
    thirdPartyAuthProviders?.google || thirdPartyAuthProviders?.saml;

  return hasThirdPartyLogin && isEmailAuthEnabled ? (
    <HorizontalSeparatorWithText className="my-5 text-muted-foreground">
      {t('or')}
    </HorizontalSeparatorWithText>
  ) : null;
};

const AuthBrandLockup = () => (
  <div className="flex flex-col items-center select-none">
    <img src="/logo-full.svg" alt="AI Qadam" className="h-24" />
    <div className="text-2xl font-light tracking-[0.45em] text-foreground/85 pl-[0.45em]">
      FLOW
    </div>
  </div>
);

const AuthImage = () => (
  <div
    aria-hidden
    className="absolute inset-0 w-full h-full flex flex-col items-center justify-center px-12 text-center"
    style={{ backgroundColor: '#3CA29E' }}
  >
    <h2 className="text-white text-[44px] leading-[1.1] font-medium max-w-md">
      Automation that&rsquo;s yours.
    </h2>
    <p className="text-white/85 text-lg mt-6 max-w-md leading-relaxed">
      Open-source AI workflows. No vendor lock-in, no phone-home.
    </p>
    <div className="absolute bottom-6 left-0 right-0 text-center text-white/75 text-[13px] tracking-wide font-medium">
      an AI Qadam Build project
    </div>
  </div>
);

const AuthLayout = ({
  children,
  isSignUp,
}: {
  children: React.ReactNode;
  isSignUp?: boolean;
}) => {
  const { setForceLightMode } = useTheme();
  useEffect(() => {
    setForceLightMode(true);
    return () => setForceLightMode(false);
  }, [setForceLightMode]);
  return (
    <div className="h-screen w-full overflow-hidden flex bg-white relative">
      {/* Form — left side */}
      <div className="flex flex-col w-full lg:w-1/2 p-5 lg:px-[100px]">
        <div className="pt-3 flex justify-center">
          <AuthBrandLockup />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-xs overflow-y-auto px-1">{children}</div>
        </div>
        {isSignUp && (
          <div className="pb-4">
            <TermsFooter />
          </div>
        )}
      </div>

      {/* Right side — brand hero (same for signup + signin) */}
      <div className="hidden lg:flex w-1/2 py-5 pr-5">
        <div className="relative w-full h-full rounded-2xl overflow-hidden bg-muted">
          <AuthImage />
        </div>
      </div>
    </div>
  );
};

AuthLayout.displayName = 'AuthLayout';

const AuthFormTemplate = React.memo(
  ({ form }: { form: 'signin' | 'signup' }) => {
    const isSignUp = form === 'signup';
    const token = authenticationSession.getToken();
    const redirectAfterLogin = useRedirectAfterLogin();
    const [showCheckYourEmailNote, setShowCheckYourEmailNote] = useState(false);
    const [showSamlLogin, setShowSamlLogin] = useState(false);
    const { data: isEmailAuthEnabled } = flagsHooks.useFlag<boolean>(
      ApFlagId.EMAIL_AUTH_ENABLED,
    );
    const data = {
      signin: {
        title: t('Welcome back'),
        description: t('Sign in to pick up where you left off.'),
      },
      signup: {
        title: t('Create a new account'),
        description: t('Join thousands of teams running on autopilot.'),
      },
    }[form];

    useEffect(() => {
      if (token) {
        redirectAfterLogin();
      }
    }, [token, redirectAfterLogin]);

    if (token) {
      return null;
    }

    if (showSamlLogin) {
      return (
        <AuthLayout isSignUp={isSignUp}>
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold tracking-tight font-sentient">
              {t('Sign in with SAML')}
            </h1>
          </div>
          <SamlLoginForm onBack={() => setShowSamlLogin(false)} />
        </AuthLayout>
      );
    }

    return (
      <AuthLayout isSignUp={isSignUp}>
        {!showCheckYourEmailNote && (
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold tracking-tight font-sentient">
              {data.title}
            </h1>
          </div>
        )}

        {!showCheckYourEmailNote && (
          <ThirdPartyLogin
            isSignUp={isSignUp}
            onSamlClick={() => setShowSamlLogin(true)}
          />
        )}
        <AuthSeparator
          isEmailAuthEnabled={
            (isEmailAuthEnabled ?? true) && !showCheckYourEmailNote
          }
        />

        {isEmailAuthEnabled ? (
          isSignUp ? (
            <SignUpForm
              setShowCheckYourEmailNote={setShowCheckYourEmailNote}
              showCheckYourEmailNote={showCheckYourEmailNote}
            />
          ) : (
            <SignInForm />
          )
        ) : null}

        <BottomNote isSignup={isSignUp} />
      </AuthLayout>
    );
  },
);

AuthFormTemplate.displayName = 'AuthFormTemplate';

export { AuthFormTemplate, AuthLayout };
