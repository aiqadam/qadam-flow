import { formErrors, localeUtil } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { useForm } from 'react-hook-form';
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

function AddLocaleDialog(props: AddLocaleDialogProps) {
  const { open, onOpenChange, existingLocales, onAdded } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <AddLocaleForm
          key={open ? 'open' : 'closed'}
          existingLocales={existingLocales}
          onOpenChange={onOpenChange}
          onAdded={onAdded}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddLocaleForm(props: AddLocaleFormProps) {
  const { existingLocales, onOpenChange, onAdded } = props;
  const form = useForm<FormValues>({
    resolver: zodResolver(buildFormSchema(existingLocales)),
    mode: 'onChange',
    defaultValues: { locale: '' },
  });

  const handleSubmit = (values: FormValues) => {
    const canonical = localeUtil.canonicalize(values.locale.trim());
    if (canonical === null) {
      return;
    }
    onAdded(canonical);
    onOpenChange(false);
  };

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(handleSubmit)}
      >
        <DialogHeader>
          <DialogTitle>{t('Add locale')}</DialogTitle>
          <DialogDescription>
            {t(
              'Adds an empty column for this locale. It is kept once at least one key has a value in it.',
            )}
          </DialogDescription>
        </DialogHeader>
        <FormField
          control={form.control}
          name="locale"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Locale')}</FormLabel>
              <FormControl>
                <Input {...field} placeholder={t('e.g. uz or en-US')} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t('Cancel')}
            </Button>
          </DialogClose>
          <Button type="submit">{t('Add')}</Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

const buildFormSchema = (existingLocales: string[]) =>
  z.object({
    locale: z
      .string()
      .trim()
      .min(1, formErrors.required)
      .refine(
        (value) => localeUtil.canonicalize(value) !== null,
        'translationLocaleInvalid',
      )
      .refine(
        (value) =>
          !existingLocales.includes(localeUtil.canonicalize(value) ?? value),
        'translationLocaleAlreadyShown',
      ),
  });

type FormValues = { locale: string };

type AddLocaleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingLocales: string[];
  onAdded: (locale: string) => void;
};

type AddLocaleFormProps = Omit<AddLocaleDialogProps, 'open'>;

export { AddLocaleDialog };
