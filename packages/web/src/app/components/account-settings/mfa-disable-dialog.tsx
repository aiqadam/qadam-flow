import { AuthenticationResponse } from '@aiqadam/shared';
import { t } from 'i18next';
import { toast } from 'sonner';

import { mfaApi } from '@/api/mfa-api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MfaCodeForm } from '@/features/authentication/components/mfa/mfa-code-form';
import { authenticationSession } from '@/lib/authentication-session';

export type MfaDisableDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabled: () => void;
};

export const MfaDisableDialog = ({
  open,
  onOpenChange,
  onDisabled,
}: MfaDisableDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Disable two-factor authentication')}</DialogTitle>
          <DialogDescription>
            {t(
              'Disabling removes the extra security step from your sign-ins. Confirm with a code from your authenticator app.',
            )}
          </DialogDescription>
        </DialogHeader>
        <MfaCodeForm
          key={open ? 'open' : 'closed'}
          allowRecoveryCode
          submitLabel={t('Disable')}
          mutationFn={(code) => mfaApi.disable({ code })}
          onSuccess={(auth: AuthenticationResponse) => {
            authenticationSession.saveResponse(auth, false);
            onDisabled();
            onOpenChange(false);
            toast.success(t('Two-factor authentication disabled.'));
          }}
        />
      </DialogContent>
    </Dialog>
  );
};
