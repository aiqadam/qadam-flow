import { MfaEnrollmentStartResponse } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { mfaApi } from '@/api/mfa-api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { MfaCodeForm } from '@/features/authentication/components/mfa/mfa-code-form';
import { MfaQrCode } from '@/features/authentication/components/mfa/mfa-qr-code';
import { MfaRecoveryCodes } from '@/features/authentication/components/mfa/mfa-recovery-codes';
import { mfaErrorUtils } from '@/features/authentication/utils/mfa-error-utils';
import { HttpError } from '@/lib/api';

export type MfaEnrollDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled: () => void;
};

export const MfaEnrollDialog = ({
  open,
  onOpenChange,
  onEnrolled,
}: MfaEnrollDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Enable two-factor authentication')}</DialogTitle>
        </DialogHeader>
        <MfaEnrollDialogContent
          key={open ? 'open' : 'closed'}
          onDone={() => {
            onEnrolled();
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
};

const PasswordSchema = z.object({
  password: z.string(),
});
type PasswordSchema = z.infer<typeof PasswordSchema>;

function MfaEnrollDialogContent({ onDone }: { onDone: () => void }) {
  const [enrollment, setEnrollment] =
    useState<MfaEnrollmentStartResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const form = useForm<PasswordSchema>({
    resolver: zodResolver(PasswordSchema),
    defaultValues: { password: '' },
    mode: 'onChange',
  });

  const { mutate: startEnrollment, isPending } = useMutation<
    MfaEnrollmentStartResponse,
    HttpError,
    string
  >({
    mutationFn: (password) =>
      mfaApi.startEnrollment(password ? { password } : {}),
    onSuccess: setEnrollment,
    onError: (error) => {
      form.setError('root.serverError', {
        message: mfaErrorUtils.resolveMfaErrorMessage(error),
      });
    },
  });

  if (recoveryCodes) {
    return (
      <MfaRecoveryCodes
        recoveryCodes={recoveryCodes}
        continueLabel={t('Done')}
        onContinue={onDone}
      />
    );
  }

  if (enrollment) {
    return (
      <div className="grid space-y-4">
        <MfaQrCode
          otpauthUrl={enrollment.otpauthUrl}
          secret={enrollment.secret}
        />
        <MfaCodeForm
          submitLabel={t('Confirm')}
          mutationFn={(code) => mfaApi.confirmEnrollment({ code })}
          onSuccess={(result) => setRecoveryCodes(result.recoveryCodes)}
        />
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        className="grid space-y-4"
        onSubmit={form.handleSubmit((data) => {
          form.clearErrors('root.serverError');
          startEnrollment(data.password);
        })}
      >
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem className="grid space-y-2">
              <FormLabel htmlFor="mfaEnrollPassword">
                {t('Account password')}
              </FormLabel>
              <Input
                {...field}
                id="mfaEnrollPassword"
                type="password"
                autoComplete="current-password"
                autoFocus
                className="rounded-sm"
              />
              <FormDescription>
                {t(
                  "Leave blank if you don't sign in with a password, such as a directory or single sign-on account.",
                )}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {form.formState.errors.root?.serverError && (
          <FormMessage>
            {form.formState.errors.root.serverError.message}
          </FormMessage>
        )}
        <Button type="submit" loading={isPending}>
          {t('Continue')}
        </Button>
      </form>
    </Form>
  );
}
