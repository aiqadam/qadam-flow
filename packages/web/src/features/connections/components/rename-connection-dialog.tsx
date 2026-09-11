import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { Pencil } from 'lucide-react';
import { useState, forwardRef } from 'react';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { appConnectionsMutations } from '../hooks/app-connections-hooks';

import { DeliveryModeSetting } from './delivery-mode-setting';

const RenameConnectionSchema = z.object({
  displayName: z.string(),
  // Settings that belong to the credential rather than to any step. Optional so a connection with
  // none — which is every one, until a qadam declares support for something here — is unaffected.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type RenameConnectionSchema = z.infer<typeof RenameConnectionSchema>;

type RenameConnectionDialogProps = {
  connectionId: string;
  currentName: string;
  userHasPermissionToRename: boolean;
  onRename: () => void;
  /** Both optional, so existing call sites keep working unchanged. */
  qadamName?: string;
  currentMetadata?: Record<string, unknown> | null;
};

const RenameConnectionDialog = forwardRef<
  HTMLDivElement,
  RenameConnectionDialogProps
>(
  (
    {
      connectionId,
      currentName,
      userHasPermissionToRename,
      onRename,
      qadamName,
      currentMetadata,
    },
    _,
  ) => {
    const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
    const renameConnectionForm = useForm<RenameConnectionSchema>({
      resolver: zodResolver(RenameConnectionSchema),
      defaultValues: {
        displayName: currentName,
        metadata: currentMetadata ?? undefined,
      },
    });

    const { mutate: renameConnection, isPending } =
      appConnectionsMutations.useRenameAppConnection({
        currentName,
        setIsRenameDialogOpen,
        renameConnectionForm,
        refetch: onRename,
      });

    return (
      <Tooltip>
        <Dialog
          open={isRenameDialogOpen}
          onOpenChange={(open) => setIsRenameDialogOpen(open)}
        >
          <DialogTrigger asChild>
            <>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!userHasPermissionToRename}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setIsRenameDialogOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {!userHasPermissionToRename
                  ? t('Permission needed')
                  : t('Edit')}
              </TooltipContent>
            </>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('Edit Connection')}</DialogTitle>
              <DialogDescription>
                {t(
                  'Change the display name, and any settings that belong to this connection.',
                )}
              </DialogDescription>
            </DialogHeader>
            <Form {...renameConnectionForm}>
              <form
                className="grid space-y-4"
                onSubmit={renameConnectionForm.handleSubmit((data) =>
                  renameConnection({
                    connectionId,
                    displayName: data.displayName,
                    metadata: data.metadata,
                  }),
                )}
              >
                {qadamName && (
                  <DeliveryModeSetting
                    qadamName={qadamName}
                    formPath="metadata"
                  />
                )}
                <FormField
                  control={renameConnectionForm.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem className="grid space-y-2">
                      <Label htmlFor="displayName">{t('Name')}</Label>
                      <Input
                        {...field}
                        id="displayName"
                        placeholder={t('New Connection Name')}
                        className="rounded-sm"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {renameConnectionForm?.formState?.errors?.root?.serverError && (
                  <FormMessage>
                    {
                      renameConnectionForm.formState.errors.root.serverError
                        .message
                    }
                  </FormMessage>
                )}
                <DialogFooter className="justify-end">
                  <DialogClose asChild>
                    <Button variant={'outline'}>{t('Cancel')}</Button>
                  </DialogClose>

                  <Button loading={isPending}>{t('Save')}</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </Tooltip>
    );
  },
);

RenameConnectionDialog.displayName = 'RenameConnectionDialog';

export { RenameConnectionDialog };
