import {
  formErrors,
  Translation,
  TRANSLATION_DESCRIPTION_MAX_LENGTH,
  TRANSLATION_VALUE_MAX_LENGTH,
  TranslationKeySchema,
  tryCatch,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { translationsApi } from '@/features/translations/api/translations';
import { translationsMutations } from '@/features/translations/hooks/translations-hooks';
import { apiErrorUtils } from '@/lib/api-error-utils';
import { authenticationSession } from '@/lib/authentication-session';

const FormSchema = z.object({
  key: TranslationKeySchema,
  description: z
    .string()
    .max(TRANSLATION_DESCRIPTION_MAX_LENGTH, 'translationDescriptionTooLong')
    .optional(),
  defaultValue: z
    .string()
    .max(TRANSLATION_VALUE_MAX_LENGTH, formErrors.translationValueTooLong)
    .optional(),
});

type FormValues = z.infer<typeof FormSchema>;

// `translationsApi.list`'s `key` filter is a substring search (ILIKE `%key%`), not an exact match,
// so a project with more matching keys than fit in one page could otherwise let a duplicate slip
// past this check unnoticed — paginate with the `next` cursor until an exact match turns up or the
// list is exhausted, rather than trusting the first page alone.
const findExistingTranslationByExactKey = async ({
  projectId,
  key,
}: {
  projectId: string;
  key: string;
}): Promise<boolean> => {
  let cursor: string | undefined;
  for (;;) {
    const page = await translationsApi.list({
      projectId,
      key,
      limit: 50,
      cursor,
    });
    if (page.data.some((translation) => translation.key === key)) {
      return true;
    }
    if (!page.next) {
      return false;
    }
    cursor = page.next;
  }
};

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
  const [isCheckingKey, setIsCheckingKey] = useState(false);

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
      form.setError('root.serverError', {
        type: 'manual',
        message: apiErrorUtils.extractServerMessage({
          error,
          fallback: t('Something went wrong, please try again later'),
        }),
      });
    },
  });

  const handleSubmit = async (values: FormValues) => {
    if (!projectId) {
      return;
    }
    form.clearErrors('root.serverError');
    if (!isEdit) {
      setIsCheckingKey(true);
      const { data: keyAlreadyExists, error } = await tryCatch(() =>
        findExistingTranslationByExactKey({ projectId, key: values.key }),
      );
      setIsCheckingKey(false);
      if (error) {
        form.setError('root.serverError', {
          type: 'manual',
          message: apiErrorUtils.extractServerMessage({
            error,
            fallback: t('Something went wrong, please try again later'),
          }),
        });
        return;
      }
      if (keyAlreadyExists) {
        form.setError('key', {
          type: 'manual',
          message: 'translationKeyAlreadyExists',
        });
        return;
      }
    }
    save(
      {
        projectId,
        translations: [
          {
            key: values.key,
            description: isEdit
              ? values.description || null
              : values.description || undefined,
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
        {form.formState.errors.root?.serverError && (
          <FormMessage>
            {form.formState.errors.root.serverError.message}
          </FormMessage>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t('Cancel')}
            </Button>
          </DialogClose>
          <Button type="submit" loading={isPending || isCheckingKey}>
            {isEdit ? t('Save') : t('Create')}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
