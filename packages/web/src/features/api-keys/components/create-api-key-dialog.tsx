import { CreateApiKeyRequest } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { CopyToClipboardInput } from '@/components/custom/clipboard/copy-to-clipboard';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { apiKeysMutations } from '../hooks/api-keys-hooks';

const defaultValues: CreateApiKeyRequest = {
  displayName: '',
};

function CreateApiKeyForm() {
  const [secret, setSecret] = useState<string | null>(null);
  const createMutation = apiKeysMutations.useCreate();

  const form = useForm<CreateApiKeyRequest>({
    resolver: zodResolver(CreateApiKeyRequest),
    defaultValues,
    mode: 'onChange',
  });

  const handleSubmit = (values: CreateApiKeyRequest) => {
    form.clearErrors('root.serverError');
    setSecret(null);
    createMutation.mutate(values, {
      onSuccess: (apiKey) => {
        setSecret(apiKey.value);
        form.reset(defaultValues);
      },
      onError: () => {
        form.setError('root.serverError', {
          type: 'manual',
          message: t('Failed to create API key'),
        });
      },
    });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-row gap-2 items-end">
          <FormField
            name="displayName"
            render={({ field }) => (
              <FormItem className="flex-1">
                <Label htmlFor="api-key-name">{t('Name')}</Label>
                <Input
                  {...field}
                  id="api-key-name"
                  placeholder={t('My API key')}
                  className="rounded-sm"
                  disabled={!!secret}
                />
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            disabled={createMutation.isPending || !!secret}
            loading={createMutation.isPending}
            className="shrink-0"
          >
            {t('Create')}
          </Button>
        </div>
        {form.formState.errors.root?.serverError && (
          <FormMessage>
            {form.formState.errors.root.serverError.message}
          </FormMessage>
        )}
        {secret && (
          <div className="flex flex-col gap-2">
            <Label>{t('API key')}</Label>
            <p className="text-sm text-muted-foreground">
              {t(
                'Copy this key now. For your security, it will not be shown again.',
              )}
            </p>
            <CopyToClipboardInput textToCopy={secret} useInput={true} />
          </div>
        )}
      </form>
    </Form>
  );
}

export function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="create-api-key-button">
          <Plus className="size-4 mr-2" />
          {t('Create API key')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Create API key')}</DialogTitle>
        </DialogHeader>
        <CreateApiKeyForm key={open ? 'open' : 'closed'} />
      </DialogContent>
    </Dialog>
  );
}
