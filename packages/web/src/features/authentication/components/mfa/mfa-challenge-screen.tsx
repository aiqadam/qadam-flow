import { AuthenticationResponse } from '@aiqadam/shared';
import { t } from 'i18next';
import { ArrowLeft } from 'lucide-react';

import { mfaApi } from '@/api/mfa-api';
import { Button } from '@/components/ui/button';

import { MfaCodeForm } from './mfa-code-form';

type MfaChallengeScreenProps = {
  mfaToken: string;
  onSuccess: (response: AuthenticationResponse) => void;
  onBack: () => void;
};

export const MfaChallengeScreen = ({
  mfaToken,
  onSuccess,
  onBack,
}: MfaChallengeScreenProps) => {
  return (
    <div className="grid space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('Enter the 6-digit code from your authenticator app to continue.')}
      </p>
      <MfaCodeForm
        allowRecoveryCode
        submitLabel={t('Verify')}
        mutationFn={(code) => mfaApi.verifyChallenge({ mfaToken, code })}
        onSuccess={onSuccess}
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
