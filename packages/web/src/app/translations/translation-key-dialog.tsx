import {
  ErrorCode,
  formErrors,
  Translation,
  TRANSLATION_KEY_REGEX,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { internalErrorToast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { translationsMutations } from '@/features/translations/hooks/translations-hooks';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';

const FormSchema = z.object({
  key: z
    .string()
    .min(1, formErrors.required)
    .regex(TRANSLATION_KEY_REGEX, 'invalidTranslationKey'),
  description: z.string().optional(),
  defaultLocale: z.string().optional(),
  defaultValue: z.string().optional(),
});

type FormValues = z.infer<typeof FormSchema>;

type TranslationKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing?: Translation;
  defaultLocale?: string | null;
  onSaved?: (translation: Translation) => void;
};

type TranslationKeyFormProps = {
  existing?: Translation;
  defaultLocale?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (translation: Translation) => void;
};

export function TranslationKeyDialog(props: TranslationKeyDialogProps) {
  const { open, onOpenChange, existing, defaultLocale, onSaved } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <TranslationKeyForm
          key={open ? `${existing?.id ?? 'new'}-open` : 'closed'}
          existing={existing}
          defaultLocale={defaultLocale}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function TranslationKeyForm(props: TranslationKeyFormProps) {
  const { existing, defaultLocale, onOpenChange, onSaved } = props;
  const isEdit = !!existing;
  const projectId = authenticationSession.getProjectId();

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onChange',
    defaultValues: {
      key: existing?.key ?? '',
      description: existing?.description ?? '',
      defaultValue: (defaultLocale && existing?.values[defaultLocale]) || '',
    },
  });

  const { mutate: save, isPending } = translationsMutations.useUpsertBatch({
    onSuccess: () => {
      toast.success(
        isEdit ? t('Translation key updated') : t('Translation key created'),
      );
    },
    onError: (error) => {
      if (api.isApError(error, ErrorCode.VALIDATION)) {
        form.setError('key', {
          type: 'manual',
          message: 'invalidTranslationKey',
        });
        return;
      }
      internalErrorToast();
    },
  });

  const handleSubmit = (values: FormValues) => {
    if (!projectId) {
      return;
    }
    save(
      {
        projectId,
        translations: [
          {
            key: values.key,
            description: values.description || null,
            values:
              defaultLocale && values.defaultValue
                ? { [defaultLocale]: values.defaultValue }
                : {},
          },
        ],
      },
      {
        onSuccess: (translations) => {
          onSaved?.(translations[0]);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(handleSubmit)}
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('Edit translation key') : t('New translation key')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Reference this key from any flow input using the $t mention — the engine resolves the right locale at run time.',
            )}
          </DialogDescription>
        </DialogHeader>
        <FormField
          control={form.control}
          name="key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Key')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  disabled={isEdit}
                  placeholder="welcome.title"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Description')}</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder={t('What is this string for?')}
                  rows={2}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {defaultLocale && (
          <FormField
            control={form.control}
            name="defaultValue"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {t('Value ({locale})', { locale: defaultLocale })}
                </FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    placeholder={t('Enter the value')}
                    rows={2}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t('Cancel')}
            </Button>
          </DialogClose>
          <Button type="submit" loading={isPending}>
            {isEdit ? t('Save') : t('Create')}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
