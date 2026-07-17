import { t } from 'i18next';
import { CheckCircle, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { FullLogo } from '@/components/custom/full-logo';
import { LoadingSpinner } from '@/components/custom/spinner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { authenticationSession } from '@/lib/authentication-session';

import { invitationMutations } from '../hooks/invitation-hooks';

export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const hasMutated = useRef(false);

  const isLoggedIn = authenticationSession.isLoggedIn();

  const { mutate, isPending, isSuccess, isError } =
    invitationMutations.useAccept();

  useEffect(() => {
    if (isLoggedIn && token && !hasMutated.current) {
      mutate({ invitationToken: token });
      hasMutated.current = true;
    }
  }, [isLoggedIn, token, mutate]);

  if (!token) {
    return <Navigate to="/sign-in" replace />;
  }

  if (!isLoggedIn) {
    return (
      <Navigate to={`/sign-in?redirect=/invitation?token=${token}`} replace />
    );
  }

  return (
    <div className="mx-auto h-screen w-screen flex flex-col items-center justify-center gap-4">
      <FullLogo />

      <Card className="w-full max-w-sm rounded-sm drop-shadow-xl p-6">
        <div className="flex flex-col gap-4 w-full">
          {isPending && (
            <div className="flex flex-row items-center gap-3">
              <LoadingSpinner className="size-6 shrink-0" />
              <span>{t('Accepting invitation...')}</span>
            </div>
          )}

          {isSuccess && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-row items-center gap-3">
                <CheckCircle className="size-6 text-success shrink-0" />
                <span>{t('Invitation accepted successfully')}</span>
              </div>
              <Button className="w-full" onClick={() => navigate('/')}>
                {t('Go to projects')}
              </Button>
            </div>
          )}

          {isError && (
            <div className="flex flex-row items-center gap-3">
              <XCircle className="size-6 text-destructive shrink-0" />
              <span>{t('Invalid or expired invitation link')}</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
