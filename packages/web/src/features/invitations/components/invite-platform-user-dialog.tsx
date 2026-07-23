import { InvitationType, PlatformRole, formErrors } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { invitationMutations } from '../hooks/invitation-hooks';

const InvitePlatformUserSchema = z.object({
  email: z.string().email(formErrors.invalidEmail),
  platformRole: z.enum([
    PlatformRole.MEMBER,
    PlatformRole.ADMIN,
    PlatformRole.OPERATOR,
  ]),
});

type InvitePlatformUserValues = z.infer<typeof InvitePlatformUserSchema>;

const defaultValues: InvitePlatformUserValues = {
  email: '',
  platformRole: PlatformRole.MEMBER,
};

function InvitePlatformUserForm() {
  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const createMutation = invitationMutations.useCreate();

  const form = useForm<InvitePlatformUserValues>({
    resolver: zodResolver(InvitePlatformUserSchema),
    defaultValues,
    mode: 'onChange',
  });

  const handleSubmit = (values: InvitePlatformUserValues) => {
    form.clearErrors('root.serverError');
    setInvitationLink(null);
    createMutation.mutate(
      {
        type: InvitationType.PLATFORM,
        email: values.email,
        platformRole: values.platformRole,
      },
      {
        onSuccess: (invitation) => {
          setInvitationLink(invitation.link ?? null);
          form.reset(defaultValues);
        },
        onError: () => {
          form.setError('root.serverError', {
            type: 'manual',
            message: t('Failed to create invitation'),
          });
        },
      },
    );
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-row gap-2 items-end">
          <FormField
            name="email"
            render={({ field }) => (
              <FormItem className="flex-1">
                <Label htmlFor="platform-invite-email">{t('Email')}</Label>
                <Input
                  {...field}
                  id="platform-invite-email"
                  placeholder="user@example.com"
                  className="rounded-sm"
                />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name="platformRole"
            render={({ field }) => (
              <FormItem>
                <Label>{t('Role')}</Label>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <SelectTrigger className="w-36 rounded-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(PlatformRole).map((role) => (
                      <SelectItem key={role} value={role}>
                        {role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            disabled={createMutation.isPending}
            loading={createMutation.isPending}
            className="shrink-0"
          >
            {t('Invite')}
          </Button>
        </div>
        {form.formState.errors.root?.serverError && (
          <FormMessage>
            {form.formState.errors.root.serverError.message}
          </FormMessage>
        )}
        {invitationLink && (
          <div className="flex flex-col gap-2">
            <Label>{t('Invitation link')}</Label>
            <p className="text-sm text-muted-foreground">
              {t('Share this link with the invited user to let them join.')}
            </p>
            <CopyToClipboardInput textToCopy={invitationLink} useInput={true} />
          </div>
        )}
      </form>
    </Form>
  );
}

export function InvitePlatformUserDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="invite-platform-user-button">
          <UserPlus className="size-4 mr-2" />
          {t('Invite user')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Invite user to platform')}</DialogTitle>
        </DialogHeader>
        <InvitePlatformUserForm key={open ? 'open' : 'closed'} />
      </DialogContent>
    </Dialog>
  );
}
