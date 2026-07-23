import {
  Alert,
  AlertChannel,
  ApFlagId,
  DefaultProjectRole,
  InvitationStatus,
  InvitationType,
  Permission,
  ProjectMemberWithUser,
  formErrors,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { CopyToClipboardInput } from '@/components/custom/clipboard/copy-to-clipboard';
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
import { Switch } from '@/components/ui/switch';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { flagsHooks } from '@/hooks/flags-hooks';

import { alertsHooks, alertsMutations } from '../../alerts/hooks/alerts-hooks';
import {
  invitationHooks,
  invitationMutations,
} from '../hooks/invitation-hooks';
import { projectMemberHooks } from '../hooks/project-member-hooks';

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
  const canReadAlert = checkAccess(Permission.READ_ALERT);
  const canWriteAlert = checkAccess(Permission.WRITE_ALERT);

  const { data: invitationsPage, refetch } = invitationHooks.useList({
    projectId,
    type: InvitationType.PROJECT,
    status: InvitationStatus.PENDING,
  });

  const invitations = invitationsPage?.data ?? [];

  const { data: members } = projectMemberHooks.useList(projectId);
  const { data: alertsPage } = alertsHooks.useList({
    projectId,
    enabled: canReadAlert,
  });
  const alerts = alertsPage?.data ?? [];

  const smtpConfigured =
    flagsHooks.useFlag<boolean>(ApFlagId.SMTP_CONFIGURED).data ?? false;

  const createMutation = invitationMutations.useCreate();
  const deleteMutation = invitationMutations.useDelete();

  const [invitationLink, setInvitationLink] = useState<string | null>(null);

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(InviteSchema),
    defaultValues,
    mode: 'onChange',
  });

  const handleSubmit = (values: InviteFormValues) => {
    form.clearErrors('root.serverError');
    setInvitationLink(null);
    createMutation.mutate(
      {
        type: InvitationType.PROJECT,
        email: values.email,
        projectId,
        projectRole: values.projectRole,
      },
      {
        onSuccess: (invitation) => {
          setInvitationLink(invitation.link ?? null);
          form.reset(defaultValues);
          refetch();
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

      {invitationLink && (
        <div className="flex flex-col gap-2">
          <Label>{t('Invitation link')}</Label>
          <p className="text-sm text-muted-foreground">
            {t('Share this link with the invited user to let them join.')}
          </p>
          <CopyToClipboardInput textToCopy={invitationLink} useInput={true} />
        </div>
      )}

      {members && members.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label>{t('Members')}</Label>
          {canWriteAlert && !smtpConfigured && (
            <p className="text-sm text-muted-foreground">
              {t(
                'Failure alerts require email (SMTP) to be configured for this platform.',
              )}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex flex-row items-center justify-between gap-3 rounded-sm border px-3 py-2 min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <TextWithTooltip tooltipMessage={member.email}>
                    <p className="text-sm truncate">
                      {[member.firstName, member.lastName]
                        .filter(Boolean)
                        .join(' ') || member.email}
                    </p>
                  </TextWithTooltip>
                  <p className="text-xs text-muted-foreground truncate">
                    {member.email}
                  </p>
                </div>
                {canWriteAlert && (
                  <MemberAlertToggle
                    projectId={projectId}
                    member={member}
                    alert={alerts.find(
                      (a) =>
                        a.receiver.toLowerCase() === member.email.toLowerCase(),
                    )}
                    disabled={!smtpConfigured}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
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

type MemberAlertToggleProps = {
  projectId: string;
  member: ProjectMemberWithUser;
  alert?: Alert;
  disabled?: boolean;
};

export function MemberAlertToggle({
  projectId,
  member,
  alert,
  disabled,
}: MemberAlertToggleProps) {
  const createMutation = alertsMutations.useCreate(projectId);
  const deleteMutation = alertsMutations.useDelete(projectId);
  const isPending = createMutation.isPending || deleteMutation.isPending;

  const handleToggle = (checked: boolean) => {
    if (checked) {
      createMutation.mutate(
        {
          projectId,
          channel: AlertChannel.EMAIL,
          receiver: member.email,
        },
        {
          onError: () => toast.error(t('Failed to enable failure alerts')),
        },
      );
      return;
    }
    if (alert) {
      deleteMutation.mutate(alert.id, {
        onError: () => toast.error(t('Failed to disable failure alerts')),
      });
    }
  };

  return (
    <div className="flex flex-row items-center gap-2 shrink-0">
      <TextWithTooltip
        tooltipMessage={t('Email this member when a flow run fails')}
      >
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t('Failure alerts')}
        </span>
      </TextWithTooltip>
      <Switch
        checked={!!alert}
        disabled={disabled || isPending}
        onCheckedChange={handleToggle}
      />
    </div>
  );
}
