import { formErrors } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { HttpError } from '@/lib/api';

import { mfaErrorUtils } from '../../utils/mfa-error-utils';

const MfaCodeSchema = z.object({
  code: z.string().min(1, formErrors.required),
});
type MfaCodeSchema = z.infer<typeof MfaCodeSchema>;

export type MfaCodeFormProps<TResult> = {
  // Whether the user may switch to entering a recovery code instead of a TOTP code. Off for
  // an enrolment confirm (recovery codes don't exist yet) and on for every re-authentication.
  allowRecoveryCode?: boolean;
  mutationFn: (code: string) => Promise<TResult>;
  onSuccess: (result: TResult) => void;
  submitLabel: string;
  footer?: React.ReactNode;
};

type MfaCodeFormFieldsProps<TResult> = MfaCodeFormProps<TResult> & {
  useRecoveryCode: boolean;
  onToggleRecoveryCode?: () => void;
};

function MfaCodeFormFields<TResult>({
  useRecoveryCode,
  onToggleRecoveryCode,
  mutationFn,
  onSuccess,
  submitLabel,
  footer,
}: MfaCodeFormFieldsProps<TResult>) {
  const form = useForm<MfaCodeSchema>({
    resolver: zodResolver(MfaCodeSchema),
    defaultValues: { code: '' },
    mode: 'onChange',
  });

  const { mutate, isPending } = useMutation<TResult, HttpError, string>({
    mutationFn,
    onSuccess,
    onError: (error) => {
      form.setError('root.serverError', {
        message: mfaErrorUtils.resolveMfaErrorMessage(error),
      });
    },
  });

  return (
    <Form {...form}>
      <form
        className="grid space-y-4"
        onSubmit={form.handleSubmit((data) => {
          form.clearErrors('root.serverError');
          mutate(data.code);
        })}
      >
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem className="grid space-y-2">
              <FormLabel htmlFor="mfaCode">
                {useRecoveryCode ? t('Recovery code') : t('Verification code')}
              </FormLabel>
              <Input
                {...field}
                id="mfaCode"
                autoFocus
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                maxLength={useRecoveryCode ? 64 : 6}
                autoComplete="one-time-code"
                placeholder={useRecoveryCode ? 'abcde-fghij' : '123456'}
                className="rounded-sm"
                data-testid="mfa-code-input"
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
          data-testid="mfa-code-submit"
        >
          {submitLabel}
        </Button>
        {onToggleRecoveryCode && (
          <Button variant="ghost" type="button" onClick={onToggleRecoveryCode}>
            {useRecoveryCode
              ? t('Use an authenticator code instead')
              : t('Use a recovery code instead')}
          </Button>
        )}
        {footer}
      </form>
    </Form>
  );
}

export function MfaCodeForm<TResult>({
  allowRecoveryCode = false,
  ...props
}: MfaCodeFormProps<TResult>) {
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  return (
    <MfaCodeFormFields
      key={useRecoveryCode ? 'recovery' : 'totp'}
      useRecoveryCode={useRecoveryCode}
      onToggleRecoveryCode={
        allowRecoveryCode ? () => setUseRecoveryCode((v) => !v) : undefined
      }
      {...props}
    />
  );
}
