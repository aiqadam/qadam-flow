import {
  DefaultProjectRole,
  InvitationStatus,
  InvitationType,
  Permission,
  formErrors,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Button } from '@/components/ui/button';
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
import { useAuthorization } from '@/hooks/authorization-hooks';

import {
  invitationHooks,
  invitationMutations,
} from '../hooks/invitation-hooks';

const InviteSchema = z.object({
  email: z.string().email(formErrors.required),
  projectRole: z.enum([
    DefaultProjectRole.ADMIN,
    DefaultProjectRole.EDITOR,
    DefaultProjectRole.VIEWER,
  ]),
});

type InviteFormValues = z.infer<typeof InviteSchema>;

const defaultValues: InviteFormValues = {
  email: '',
  projectRole: DefaultProjectRole.VIEWER,
};

type ProjectMembersTabProps = {
  projectId: string;
};

export function ProjectMembersTab({ projectId }: ProjectMembersTabProps) {
  const { checkAccess } = useAuthorization();
  const canInvite = checkAccess(Permission.WRITE_INVITATION);

  const { data: invitationsPage, refetch } = invitationHooks.useList({
    projectId,
    type: InvitationType.PROJECT,
    status: InvitationStatus.PENDING,
  });

  const invitations = invitationsPage?.data ?? [];

  const createMutation = invitationMutations.useCreate();
  const deleteMutation = invitationMutations.useDelete();

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(InviteSchema),
    defaultValues,
    mode: 'onChange',
  });

  const handleSubmit = (values: InviteFormValues) => {
    form.clearErrors('root.serverError');
    createMutation.mutate(
      {
        type: InvitationType.PROJECT,
        email: values.email,
        projectId,
        projectRole: values.projectRole,
      },
      {
        onSuccess: () => {
          form.reset(defaultValues);
          refetch();
        },
        onError: () => {
          form.setError('root.serverError', {
            type: 'manual',
            message: t('Failed to send invitation'),
          });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {canInvite && (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-row gap-2 items-end">
              <FormField
                name="email"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Label htmlFor="invite-email">{t('Email')}</Label>
                    <Input
                      {...field}
                      id="invite-email"
                      placeholder="user@example.com"
                      className="rounded-sm"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                name="projectRole"
                render={({ field }) => (
                  <FormItem>
                    <Label>{t('Role')}</Label>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <SelectTrigger className="w-32 rounded-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(DefaultProjectRole).map((role) => (
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
            <FormMessage />
          </form>
        </Form>
      )}

      {invitations.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label>{t('Pending')}</Label>
          <div className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex flex-row items-center justify-between gap-2 rounded-sm border px-3 py-2 min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <TextWithTooltip tooltipMessage={invitation.email}>
                    <p className="text-sm truncate">{invitation.email}</p>
                  </TextWithTooltip>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0 shrink-0 text-destructive hover:text-destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(invitation.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
