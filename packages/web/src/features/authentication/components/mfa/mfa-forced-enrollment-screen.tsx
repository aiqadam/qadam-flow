import { AuthenticationResponse } from '@aiqadam/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';

import { mfaApi } from '@/api/mfa-api';
import { LoadingSpinner } from '@/components/custom/spinner';
import { Button } from '@/components/ui/button';

import { MfaCodeForm } from './mfa-code-form';
import { MfaQrCode } from './mfa-qr-code';
import { MfaRecoveryCodes } from './mfa-recovery-codes';

type MfaForcedEnrollmentScreenProps = {
  mfaToken: string;
  onComplete: (response: AuthenticationResponse) => void;
  onBack: () => void;
};

export const MfaForcedEnrollmentScreen = ({
  mfaToken,
  onComplete,
  onBack,
}: MfaForcedEnrollmentScreenProps) => {
  const [confirmed, setConfirmed] = useState<{
    auth: AuthenticationResponse;
    recoveryCodes: string[];
  } | null>(null);

  const {
    data: enrollment,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['mfa-pending-enrollment', mfaToken],
    queryFn: () => mfaApi.startPendingEnrollment({ mfaToken }),
    retry: false,
  });

  if (confirmed) {
    return (
      <MfaRecoveryCodes
        recoveryCodes={confirmed.recoveryCodes}
        continueLabel={t('Continue')}
        onContinue={() => onComplete(confirmed.auth)}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  if (isError || !enrollment) {
    return (
      <div className="grid space-y-4">
        <p className="text-sm text-destructive">
          {t("Couldn't start two-factor setup. Try again.")}
        </p>
        <Button type="button" onClick={() => refetch()}>
          {t('Try again')}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('Back to sign in')}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid space-y-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'Your organization requires two-factor authentication. Set it up now to continue.',
        )}
      </p>
      <MfaQrCode otpauthUrl={enrollment.otpauthUrl} secret={enrollment.secret} />
      <MfaCodeForm
        submitLabel={t('Confirm')}
        mutationFn={(code) => mfaApi.confirmPendingEnrollment({ mfaToken, code })}
        onSuccess={setConfirmed}
        footer={
          <Button variant="ghost" type="button" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('Back to sign in')}
          </Button>
        }
      />
    </div>
  );
};
