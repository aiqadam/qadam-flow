import { t } from 'i18next';
import { useState } from 'react';

import { mfaApi } from '@/api/mfa-api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MfaCodeForm } from '@/features/authentication/components/mfa/mfa-code-form';
import { MfaRecoveryCodes } from '@/features/authentication/components/mfa/mfa-recovery-codes';

export type MfaRegenerateCodesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const MfaRegenerateCodesDialog = ({
  open,
  onOpenChange,
}: MfaRegenerateCodesDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Regenerate recovery codes')}</DialogTitle>
          <DialogDescription>
            {t(
              'Your old recovery codes stop working once new ones are generated. Confirm with a code from your authenticator app.',
            )}
          </DialogDescription>
        </DialogHeader>
        <MfaRegenerateCodesDialogContent
          key={open ? 'open' : 'closed'}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
};

function MfaRegenerateCodesDialogContent({
  onDone,
}: {
  onDone: () => void;
}) {
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  if (recoveryCodes) {
    return (
      <MfaRecoveryCodes
        recoveryCodes={recoveryCodes}
        continueLabel={t('Done')}
        onContinue={onDone}
      />
    );
  }

  return (
    <MfaCodeForm
      allowRecoveryCode
      submitLabel={t('Regenerate')}
      mutationFn={(code) => mfaApi.regenerateRecoveryCodes({ code })}
      onSuccess={(result) => setRecoveryCodes(result.recoveryCodes)}
    />
  );
}
