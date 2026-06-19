import {
  AddQadamRequestBody,
  ApFlagId,
  PackageType,
  QadamScope,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { HttpStatusCode } from 'axios';
import { t } from 'i18next';
import pako from 'pako';
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { AnimatedIconButton } from '@/components/custom/animated-icon-button';
import { ApMarkdown } from '@/components/custom/markdown';
import { PlusIcon } from '@/components/icons/plus';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { flagsHooks } from '@/hooks/flags-hooks';
import { platformHooks } from '@/hooks/platform-hooks';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';

import { qadamsApi } from '../api/qadams-api';
const FormSchema = z.object({
  packageType: z.nativeEnum(PackageType),
  qadamName: z.string().optional(),
  scope: z.nativeEnum(QadamScope),
  qadamVersion: z.string().optional(),
  pieceArchive: z.unknown().optional(),
});

type InstallQadamDialogProps = {
  onInstallPiece: () => void;
  scope: QadamScope;
};
const InstallQadamDialog = ({
  onInstallPiece,
  scope,
}: InstallQadamDialogProps) => {
  const { platform } = platformHooks.useCurrentPlatform();
  const isEnabled = platform.plan.managePiecesEnabled;
  const [isOpen, setIsOpen] = useState(false);

  const { data: privatePiecesEnabled } = flagsHooks.useFlag<boolean>(
    ApFlagId.PRIVATE_PIECES_ENABLED,
  );

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      scope,
      packageType: PackageType.REGISTRY,
    },
  });

  const handleArchiveUpload = async (file: File) => {
    if (file && file.name.endsWith('.tgz')) {
      try {
        const fileBuffer = await file.arrayBuffer();
        const decompressedData = pako.ungzip(new Uint8Array(fileBuffer));
        const text = new TextDecoder().decode(decompressedData);

        // Look for package.json content in the decompressed data
        const packageJsonMatch = text.match(
          /package\.json.*?{[^}]*"name"\s*:\s*"([^"]+)".*?"version"\s*:\s*"([^"]+)"/s,
        );
        if (packageJsonMatch) {
          form.setValue('qadamName', packageJsonMatch[1]);
          form.setValue('qadamVersion', packageJsonMatch[2]);
        } else {
          form.setError('pieceArchive', {
            message: t('package.json not found in archive'),
          });
        }
      } catch (error) {
        console.error('Error processing file:', error);
        form.setError('pieceArchive', {
          message: t('Error processing archive file'),
        });
      }
    } else {
      form.setError('pieceArchive', {
        message: t('Please upload a .tgz file'),
      });
    }
  };

  const { mutate, isPending } = useMutation<void, Error, AddQadamRequestBody>({
    mutationFn: async (data) => {
      form.clearErrors();

      if (data.packageType === PackageType.REGISTRY) {
        if (!data.qadamName) {
          form.setError('qadamName', {
            message: t('Qadam name is required for NPM Registry'),
          });
        }
        if (!data.qadamVersion) {
          form.setError('qadamVersion', {
            message: t('Qadam version is required for NPM Registry'),
          });
        }
        if (!data.qadamName || !data.qadamVersion) {
          throw new Error('Validation failed');
        }
      }

      await qadamsApi.install(data);
    },
    onSuccess: () => {
      setIsOpen(false);
      form.reset();
      onInstallPiece();
      toast.success(t('Qadam installed'), {
        duration: 3000,
      });
    },
    onError: (error) => {
      if (api.isError(error)) {
        switch (error.response?.status) {
          case HttpStatusCode.Conflict:
            form.setError('root.serverError', {
              message: t(
                'A qadam with this name and version is already installed. Please update the version number in package.json and try again.',
              ),
            });
            break;
          default:
            form.setError('root.serverError', {
              message: t('Something went wrong, please try again later'),
            });
            break;
        }
      }
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => setIsOpen(open)}>
      <DialogTrigger asChild>
        <AnimatedIconButton icon={PlusIcon} iconSize={16} size="sm">
          {t('Install Qadam')}
        </AnimatedIconButton>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Install a qadam')}</DialogTitle>
          <DialogDescription>
            <ApMarkdown
              markdown={
                'Use this to install a [custom qadam](https://flow.aiqadam.org/docs/build-qadams/building-qadams/create-action) that you (or someone else) created. Once the qadam is installed, you can use it in the flow builder.\n\nWarning: Make sure you trust the author as the qadam will have access to your flow data and it might not be compatible with the current version of Qadam Flow.'
              }
            />
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit((data) =>
              mutate({
                projectId: authenticationSession.getProjectId()!,
                ...data,
              } as AddQadamRequestBody),
            )}
          >
            <FormField
              name="packageType"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="packageType">
                    {t('Package Type')}
                  </FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      if (value === PackageType.ARCHIVE) {
                        form.setValue('qadamName', undefined);
                        form.setValue('qadamVersion', undefined);
                      }
                      form.clearErrors();
                    }}
                    defaultValue={PackageType.REGISTRY}
                  >
                    <SelectTrigger>
                      <SelectValue defaultValue={PackageType.REGISTRY} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={PackageType.REGISTRY}>
                          {t('NPM Registry')}
                        </SelectItem>
                        <SelectItem
                          value={PackageType.ARCHIVE}
                          disabled={!isEnabled || !privatePiecesEnabled}
                        >
                          {t('Packed Archive (.tgz)')}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {form.watch('packageType') === PackageType.REGISTRY && (
              <>
                <FormField
                  name="qadamName"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel htmlFor="qadamName">
                        {t('Qadam Name')}
                      </FormLabel>
                      <Input
                        {...field}
                        value={field.value || ''}
                        id="qadamName"
                        type="text"
                        placeholder="@aiqadam/qadam-name"
                        className="rounded-sm"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  name="qadamVersion"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel htmlFor="qadamVersion">
                        {t('Qadam Version')}
                      </FormLabel>
                      <Input
                        {...field}
                        value={field.value || ''}
                        id="qadamVersion"
                        type="text"
                        placeholder="0.0.1"
                        className="rounded-sm"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {form.watch('packageType') === PackageType.ARCHIVE && (
              <FormField
                name="pieceArchive"
                control={form.control}
                render={({
                  field: { value: _value, onChange, ...fieldProps },
                }) => (
                  <FormItem>
                    <FormLabel htmlFor="pieceArchive">
                      {t('Package Archive')}
                    </FormLabel>
                    <Input
                      {...fieldProps}
                      id="pieceArchive"
                      type="file"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          onChange(file);
                          handleArchiveUpload(file);
                        }
                      }}
                      placeholder={t('Package archive')}
                      className="rounded-sm"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {form?.formState?.errors?.root?.serverError && (
              <FormMessage>
                {form.formState.errors.root.serverError.message}
              </FormMessage>
            )}
            <Button loading={isPending} type="submit">
              {t('Install')}
            </Button>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
};

export { InstallQadamDialog };
