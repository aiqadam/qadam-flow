import { DeclareTableKeyRequest, Table } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import i18n, { t } from 'i18next';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiErrorUtils } from '@/lib/api-error-utils';

import { fieldsApi } from '../api/fields-api';
import { tableMutations } from '../hooks/table-hooks';

import { useTableState } from './ap-table-state-provider';

type ManageTableKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ManageTableKeyDialog({
  open,
  onOpenChange,
}: ManageTableKeyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Unique Key')}</DialogTitle>
          <DialogDescription>
            {t(
              'Choose one or more fields whose combined values must be unique across every record in this table. Clear the selection to remove the key.',
            )}
          </DialogDescription>
        </DialogHeader>
        <ManageTableKeyForm
          key={open ? 'open' : 'closed'}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function ManageTableKeyForm({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const table = useTableState((state) => state.table);
  const setTableKeyFieldIds = useTableState(
    (state) => state.setTableKeyFieldIds,
  );

  // Field metadata for a settings dialog, not primary table data — kept out of the
  // global error dialog per AGENTS.md's query-error-handling rule, and re-fetched fresh
  // (rather than reusing the client store's `fields`) because a field just created
  // through the popup still carries a client-generated id there until its create
  // request resolves, and `keyFieldIds` must be real backend field ids.
  const { data: fields, isLoading } = useQuery({
    queryKey: ['table-fields-for-key', table.id],
    queryFn: () => fieldsApi.list({ tableId: table.id }),
  });

  const form = useForm<DeclareTableKeyRequest>({
    resolver: zodResolver(DeclareTableKeyRequest),
    defaultValues: {
      keyFieldIds: table.keyFieldIds ?? [],
    },
  });

  const { mutate: declareKey, isPending } = tableMutations.useDeclareTableKey({
    onSuccess: (updatedTable: Table) => {
      setTableKeyFieldIds(updatedTable.keyFieldIds);
      toast.success(t('Unique key updated'));
      onOpenChange(false);
    },
    onError: (error) => {
      const message = apiErrorUtils.extractServerMessage({
        error,
        fallback: 'Something went wrong, please try again later',
      });
      form.setError('root.serverError', {
        type: 'manual',
        message: i18n.exists(message) ? t(message) : message,
      });
    },
  });

  const selectedFieldIds = form.watch('keyFieldIds');

  return (
    <Form {...form}>
      <form
        className="grid space-y-4"
        onSubmit={form.handleSubmit((data) => {
          form.clearErrors('root.serverError');
          declareKey({ tableId: table.id, keyFieldIds: data.keyFieldIds });
        })}
      >
        <FormField
          control={form.control}
          name="keyFieldIds"
          render={() => (
            <FormItem className="grid space-y-2">
              <ScrollArea className="max-h-[240px] rounded-md border">
                <div className="p-2 space-y-1">
                  {(fields ?? []).map((field) => (
                    <label
                      key={field.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedFieldIds.includes(field.id)}
                        onCheckedChange={(checked) => {
                          const next = checked
                            ? [...selectedFieldIds, field.id]
                            : selectedFieldIds.filter((id) => id !== field.id);
                          form.setValue('keyFieldIds', next, {
                            shouldDirty: true,
                          });
                        }}
                      />
                      <span className="text-sm truncate">{field.name}</span>
                    </label>
                  ))}
                  {!isLoading && (fields ?? []).length === 0 && (
                    <div className="px-2 py-4 text-sm text-center text-muted-foreground">
                      {t('No fields available')}
                    </div>
                  )}
                </div>
              </ScrollArea>
              <FormMessage />
            </FormItem>
          )}
        />
        {form.formState.errors.root?.serverError && (
          <FormMessage>
            {form.formState.errors.root.serverError.message}
          </FormMessage>
        )}
        <DialogFooter className="justify-between items-center flex-row">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectedFieldIds.length === 0}
            onClick={() =>
              form.setValue('keyFieldIds', [], { shouldDirty: true })
            }
          >
            {t('Clear')}
          </Button>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('Cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" loading={isPending}>
              {t('Save')}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </Form>
  );
}
