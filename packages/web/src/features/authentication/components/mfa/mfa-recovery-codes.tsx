import { t } from 'i18next';

import { CopyToClipboardInput } from '@/components/custom/clipboard/copy-to-clipboard';
import { Button } from '@/components/ui/button';

type MfaRecoveryCodesProps = {
  recoveryCodes: string[];
  onContinue: () => void;
  continueLabel: string;
};

export const MfaRecoveryCodes = ({
  recoveryCodes,
  onContinue,
  continueLabel,
}: MfaRecoveryCodesProps) => {
  return (
    <div className="grid space-y-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'Store these recovery codes somewhere safe. Each one can be used once to sign in if you lose access to your authenticator app.',
        )}
      </p>
      <CopyToClipboardInput
        textToCopy={recoveryCodes.join('\n')}
        useInput={false}
        fileName="recovery-codes.txt"
      />
      <Button
        type="button"
        onClick={onContinue}
        data-testid="mfa-recovery-codes-continue"
      >
        {continueLabel}
      </Button>
    </div>
  );
};
