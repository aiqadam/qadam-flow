import { QadamsFilterType } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Form, FormField, FormItem } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { projectCollectionUtils } from '@/features/projects';
import { qadamsHooks } from '@/features/qadams';

import { MultiSelectQadamProperty } from '../../../../components/custom/multi-select-qadam-property';
import { authenticationSession } from '../../../../lib/authentication-session';

type ManagePiecesDialogProps = {
  onSuccess: () => void;
};

export const ManagePiecesDialog = React.memo(
  ({ onSuccess }: ManagePiecesDialogProps) => {
    const [open, setOpen] = useState(false);
    const { qadams: visibleQadams, isLoading: isLoadingVisiblePieces } =
      qadamsHooks.useQadams({ searchQuery: '', includeHidden: false });
    useEffect(() => {
      form.setValue(
        'pieces',
        (visibleQadams ?? []).map((p) => p.name),
      );
    }, [isLoadingVisiblePieces]);
    const form = useForm<{
      pieces: string[];
    }>({
      resolver: zodResolver(
        z.object({
          pieces: z.array(z.string()),
        }),
      ),
      defaultValues: {
        pieces: (visibleQadams ?? []).map((p) => p.name),
      },
    });

    const { qadams: allQadams, isLoading: isLoadingAllPieces } =
      qadamsHooks.useQadams({ searchQuery: '', includeHidden: true });

    return (
      <Dialog open={open} onOpenChange={(open) => setOpen(open)}>
        <DialogTrigger asChild>
          <Button variant="default" className="flex gap-2 items-center">
            {t('Manage Qadams')}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Manage Qadams')}</DialogTitle>
            <DialogDescription>
              {t(
                'Choose which qadams you want to be available for your current project users',
              )}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form className="flex flex-col gap-4 mb-4">
              <FormField
                name="pieces"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <Label htmlFor="pieces">{t('Qadams')}</Label>
                    <MultiSelectQadamProperty
                      placeholder={t('Qadams')}
                      options={
                        allQadams?.map((piece) => ({
                          value: piece.name,
                          label: piece.displayName,
                        })) ?? []
                      }
                      loading={isLoadingAllPieces || isLoadingVisiblePieces}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      initialValues={field.value}
                      showDeselect={field.value.length > 0}
                    ></MultiSelectQadamProperty>
                  </FormItem>
                )}
              />
            </form>
          </Form>
          <DialogFooter>
            <Button
              variant={'outline'}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setOpen(false);
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                form.handleSubmit(() => {
                  projectCollectionUtils.update(
                    authenticationSession.getProjectId()!,
                    {
                      plan: {
                        piecesFilterType: QadamsFilterType.ALLOWED,
                        pieces: form.getValues().pieces,
                      },
                    },
                  );
                  onSuccess();
                  setOpen(false);
                })(e);
              }}
            >
              {t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
);
ManagePiecesDialog.displayName = 'ManagePiecesDialog';
