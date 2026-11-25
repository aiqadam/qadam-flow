import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';

import { mfaApi } from '@/api/mfa-api';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

import { MfaDisableDialog } from './mfa-disable-dialog';
import { MfaEnrollDialog } from './mfa-enroll-dialog';
import { MfaRegenerateCodesDialog } from './mfa-regenerate-codes-dialog';

const MFA_STATUS_QUERY_KEY = ['mfa-status'];

export const MfaSettings = () => {
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: MFA_STATUS_QUERY_KEY,
    queryFn: () => mfaApi.getStatus(),
  });

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: MFA_STATUS_QUERY_KEY });

  return (
    <>
      <Separator />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold flex items-center gap-2">
            {status?.enrolled ? (
              <ShieldCheck className="w-4 h-4 text-primary" />
            ) : (
              <ShieldOff className="w-4 h-4 text-muted-foreground" />
            )}
            {t('Two-factor authentication')}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {status?.enrolled
              ? t('{count, plural, =1 {1 recovery code left} other {# recovery codes left}}', {
                  count: status.recoveryCodesRemaining,
                })
              : t(
                  'Add an extra layer of security to your account by requiring a code from your authenticator app when you sign in.',
                )}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {!isLoading && status && (
            <>
              {status.enrolled ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRegenerateOpen(true)}
                  >
                    {t('Regenerate codes')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setDisableOpen(true)}
                  >
                    {t('Disable')}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setEnrollOpen(true)}
                >
                  {t('Enable')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <MfaEnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        onEnrolled={invalidateStatus}
      />
      <MfaDisableDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        onDisabled={invalidateStatus}
      />
      <MfaRegenerateCodesDialog
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
      />
    </>
  );
};
