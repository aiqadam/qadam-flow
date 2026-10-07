import {
  Alert,
  AlertChannel,
  ApFlagId,
  DefaultProjectRole,
  InvitationStatus,
  InvitationType,
  isNil,
  Permission,
  ProjectMemberManagedBy,
  ProjectMemberWithUser,
  formErrors,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { useDebounce } from 'use-debounce';
import { z } from 'zod';

import { CopyToClipboardInput } from '@/components/custom/clipboard/copy-to-clipboard';
import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { projectCollectionUtils } from '@/features/projects';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { flagsHooks } from '@/hooks/flags-hooks';
import { authenticationSession } from '@/lib/authentication-session';

import { alertsHooks, alertsMutations } from '../../alerts/hooks/alerts-hooks';
import {
  invitationHooks,
  invitationMutations,
} from '../hooks/invitation-hooks';
import {
  projectMemberHooks,
  projectMemberMutations,
  projectMemberQueries,
} from '../hooks/project-member-hooks';

const PROJECT_ROLE_OPTIONS = Object.values(DefaultProjectRole);

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
  const queryClient = useQueryClient();
  const { checkAccess } = useAuthorization();
  const canInvite = checkAccess(Permission.WRITE_INVITATION);
  const canManageMembers = checkAccess(Permission.WRITE_PROJECT_MEMBER);
  // Managing alerts needs both: READ to know the current on/off state, WRITE to change it.
  // Rendering the toggle on WRITE alone (without READ) would show every alert as "off" and
  // re-create duplicates on enable.
  const canManageAlerts =
    checkAccess(Permission.READ_ALERT) && checkAccess(Permission.WRITE_ALERT);

  const { project } = projectCollectionUtils.useCurrentProject();
  const currentUserId = authenticationSession.getCurrentUserId();

  const { data: invitationsPage, refetch } = invitationHooks.useList({
    projectId,
    type: InvitationType.PROJECT,
    status: InvitationStatus.PENDING,
  });

  const invitations = invitationsPage?.data ?? [];

  const { data: members } = projectMemberHooks.useList(projectId);
  const { data: alertsPage } = alertsHooks.useList({
    projectId,
    enabled: canManageAlerts,
  });
  const alerts = alertsPage?.data ?? [];

  const smtpConfigured =
    flagsHooks.useFlag<boolean>(ApFlagId.SMTP_CONFIGURED).data ?? false;

  const createMutation = invitationMutations.useCreate();
  const deleteMutation = invitationMutations.useDelete(projectId);
  const updateMutation = projectMemberMutations.useUpdate(projectId);
  const removeMutation = projectMemberMutations.useRemove(projectId);

  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] =
    useState<ProjectMemberWithUser | null>(null);

  const adminCount = (members ?? []).filter(
    (member) => member.projectRole === DefaultProjectRole.ADMIN,
  ).length;

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
          // An already-registered platform user is added outright (auto-accept); everyone else
          // gets a pending invitation. Saying which one happened is the whole point of the
          // feedback — the form used to just reset, reading as "nothing happened".
          if (invitation.status === InvitationStatus.ACCEPTED) {
            toast.success(t('Added to the project'));
          } else if (invitation.link) {
            setInvitationLink(invitation.link);
          } else {
            toast.success(t('Invitation sent'));
          }
          form.reset(defaultValues);
          refetch();
          projectMemberQueries.invalidate({ queryClient, projectId });
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

  const handleRoleChange = ({
    member,
    projectRole,
  }: {
    member: ProjectMemberWithUser;
    projectRole: DefaultProjectRole;
  }) => {
    updateMutation.mutate(
      { memberId: member.id, projectRole },
      {
        onSuccess: () => toast.success(t('Role updated')),
        onError: () => toast.error(t('Failed to update role')),
      },
    );
  };

  const handleRemove = (member: ProjectMemberWithUser) => {
    removeMutation.mutate(member.id, {
      onSuccess: () => {
        toast.success(t('Member removed'));
        setMemberToRemove(null);
      },
      onError: () => toast.error(t('Failed to remove member')),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {canInvite && (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <FormField
                name="email"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Label htmlFor="invite-email">{t('Email')}</Label>
                    <div className="flex flex-row gap-2">
                      <Input
                        {...field}
                        id="invite-email"
                        placeholder="user@example.com"
                        className="rounded-sm"
                      />
                      <CandidatePicker
                        projectId={projectId}
                        onSelect={(email) =>
                          form.setValue('email', email, {
                            shouldValidate: true,
                          })
                        }
                      />
                    </div>
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
                      <SelectTrigger
                        data-testid="invite-role-select"
                        className="w-32 rounded-sm"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_ROLE_OPTIONS.map((role) => (
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
          {canManageAlerts && !smtpConfigured && (
            <p className="text-sm text-muted-foreground">
              {t(
                'Failure alerts require email (SMTP) to be configured for this platform.',
              )}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                alert={alerts.find(
                  (a) =>
                    a.receiver.toLowerCase() === member.email.toLowerCase(),
                )}
                projectId={projectId}
                canManageAlerts={canManageAlerts}
                canManageMembers={canManageMembers}
                smtpConfigured={smtpConfigured}
                isSelf={member.userId === currentUserId}
                isOwner={member.userId === project?.ownerId}
                isLastAdmin={
                  member.projectRole === DefaultProjectRole.ADMIN &&
                  adminCount <= 1
                }
                isUpdating={
                  updateMutation.isPending &&
                  updateMutation.variables?.memberId === member.id
                }
                onRoleChange={handleRoleChange}
                onRequestRemove={setMemberToRemove}
              />
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

      <Dialog
        open={!isNil(memberToRemove)}
        onOpenChange={(open) => {
          if (!open) {
            setMemberToRemove(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Remove member')}</DialogTitle>
            <DialogDescription>
              {t('Remove {email} from this project?', {
                email: memberToRemove?.email ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMemberToRemove(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={removeMutation.isPending}
              disabled={removeMutation.isPending}
              onClick={() => memberToRemove && handleRemove(memberToRemove)}
            >
              {t('Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type CandidatePickerProps = {
  projectId: string;
  onSelect: (email: string) => void;
};

function CandidatePicker({ projectId, onSelect }: CandidatePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebounce(search, 200);
  // Search server-side as the user types: a platform larger than the result cap would otherwise be
  // only partially reachable through the picker.
  const { data: candidates } = projectMemberHooks.useListCandidates({
    projectId,
    enabled: open,
    search: debouncedSearch,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="shrink-0">
          <UserPlus className="size-4" />
          {t('Select member')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('Search by email')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{t('No members found')}</CommandEmpty>
            <CommandGroup>
              {(candidates ?? []).map((candidate) => (
                <CommandItem
                  key={candidate.userId}
                  value={`${getMemberDisplayName(candidate)} ${candidate.email}`}
                  onSelect={() => {
                    onSelect(candidate.email);
                    setOpen(false);
                  }}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">
                      {getMemberDisplayName(candidate)}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {candidate.email}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type MemberRowProps = {
  member: ProjectMemberWithUser;
  alert?: Alert;
  projectId: string;
  canManageAlerts: boolean;
  canManageMembers: boolean;
  smtpConfigured: boolean;
  isSelf: boolean;
  isOwner: boolean;
  isLastAdmin: boolean;
  isUpdating: boolean;
  onRoleChange: (params: {
    member: ProjectMemberWithUser;
    projectRole: DefaultProjectRole;
  }) => void;
  onRequestRemove: (member: ProjectMemberWithUser) => void;
};

function MemberRow({
  member,
  alert,
  projectId,
  canManageAlerts,
  canManageMembers,
  smtpConfigured,
  isSelf,
  isOwner,
  isLastAdmin,
  isUpdating,
  onRoleChange,
  onRequestRemove,
}: MemberRowProps) {
  const disabledReason = getMemberControlDisabledReason({
    isSelf,
    isOwner,
    isManagedByDirectory: member.managedBy === ProjectMemberManagedBy.LDAP,
    isLastAdmin,
  });
  const controlsDisabled = !isNil(disabledReason);

  return (
    <div
      data-testid="project-member-row"
      className="flex flex-row items-center justify-between gap-3 rounded-sm border px-3 py-2 min-w-0"
    >
      <div className="min-w-0 flex-1">
        <TextWithTooltip tooltipMessage={member.email}>
          <p className="text-sm truncate">{getMemberDisplayName(member)}</p>
        </TextWithTooltip>
        <p className="text-xs text-muted-foreground truncate">{member.email}</p>
      </div>
      {canManageAlerts && (
        <MemberAlertToggle
          projectId={projectId}
          member={member}
          alert={alert}
          disabled={!smtpConfigured}
        />
      )}
      {canManageMembers && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-row items-center gap-2 shrink-0">
              <Select
                value={member.projectRole}
                disabled={controlsDisabled || isUpdating}
                onValueChange={(role) => {
                  if (isDefaultProjectRole(role)) {
                    onRoleChange({ member, projectRole: role });
                  }
                }}
              >
                <SelectTrigger
                  className="w-28 rounded-sm"
                  aria-label={t('Role')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('Remove member')}
                className="size-8 p-0 shrink-0 text-destructive hover:text-destructive"
                disabled={controlsDisabled || isUpdating}
                onClick={() => onRequestRemove(member)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </TooltipTrigger>
          {!isNil(disabledReason) && (
            <TooltipContent>{disabledReason}</TooltipContent>
          )}
        </Tooltip>
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

function MemberAlertToggle({
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

function isDefaultProjectRole(role: string): role is DefaultProjectRole {
  const roles: string[] = Object.values(DefaultProjectRole);
  return roles.includes(role);
}

function getMemberDisplayName({
  firstName,
  lastName,
  email,
}: {
  firstName: string;
  lastName: string;
  email: string;
}): string {
  return [firstName, lastName].filter(Boolean).join(' ') || email;
}

function getMemberControlDisabledReason({
  isSelf,
  isOwner,
  isManagedByDirectory,
  isLastAdmin,
}: GetMemberControlDisabledReasonParams): string | undefined {
  if (isSelf) {
    return t('You cannot change your own membership');
  }
  if (isOwner) {
    return t('The project owner cannot be changed here');
  }
  if (isManagedByDirectory) {
    return t('This member is managed by your directory');
  }
  if (isLastAdmin) {
    return t('The last admin cannot be removed or demoted');
  }
  return undefined;
}

type GetMemberControlDisabledReasonParams = {
  isSelf: boolean;
  isOwner: boolean;
  isManagedByDirectory: boolean;
  isLastAdmin: boolean;
};
