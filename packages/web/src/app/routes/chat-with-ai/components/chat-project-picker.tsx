import { isNil, ProjectType } from '@aiqadam/shared';
import { t } from 'i18next';
import { Check, ChevronDown, Folder } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getProjectName, projectCollectionUtils } from '@/features/projects';
import { authenticationSession } from '@/lib/authentication-session';
import { cn } from '@/lib/utils';

export function ChatProjectPicker({
  projectId,
  onProjectChange,
  locked,
  disabled = false,
}: ChatProjectPickerProps) {
  const [open, setOpen] = React.useState(false);
  const { projects, defaultProject } = useChatProjects();

  // With a single project there is no choice to make, same as the model picker hiding itself when
  // there is nothing to pick from.
  if (projects.length < 2) {
    return null;
  }

  // A locked conversation with no project lost it to a deletion (the FK is ON DELETE SET NULL);
  // naming the default there would claim a project the server will refuse to run in.
  const selectedProject = isNil(projectId)
    ? locked
      ? undefined
      : defaultProject
    : projects.find((project) => project.id === projectId);
  const label = isNil(selectedProject)
    ? t('Project')
    : getProjectName(selectedProject);

  const handleSelect = (id: string) => {
    onProjectChange(id);
    setOpen(false);
  };

  const trigger = (
    <Button
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={open}
      disabled={disabled || locked}
      className="h-7 gap-1.5 rounded-full px-3 text-xs font-medium"
    >
      <Folder className="size-3.5 text-muted-foreground shrink-0" />
      <span className="max-w-32 truncate">{label}</span>
      {!locked && <ChevronDown className="size-3 shrink-0 opacity-50" />}
    </Button>
  );

  // The server refuses a repin once the conversation has run (`repinProject`), so the control says
  // why it stopped responding instead of looking broken. The span is there because a disabled
  // button fires no pointer events for the tooltip to hang on.
  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{trigger}</span>
        </TooltipTrigger>
        <TooltipContent>
          {t('Start a new conversation to work in another project.')}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="p-0 w-64" align="start">
        <Command>
          <CommandInput placeholder={t('Search projects...')} />
          <CommandEmpty>{t('No project found.')}</CommandEmpty>
          <CommandGroup className="max-h-64 overflow-auto">
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`${getProjectName(project)} ${project.id}`}
                onSelect={() => handleSelect(project.id)}
                className="cursor-pointer"
              >
                <span className="flex-1 truncate">
                  {getProjectName(project)}
                </span>
                <Check
                  className={cn(
                    'ml-auto h-4 w-4',
                    selectedProject?.id === project.id
                      ? 'opacity-100'
                      : 'opacity-0',
                  )}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// The default is the project shown before anything is picked, and the chat sends it explicitly when
// the conversation is created — so what the picker shows is what the run works in, rather than a
// client-side guess at the server's own fallback. The preference matches that fallback anyway
// (`resolveProjectId`): the user's own personal project first.
export function useChatProjects() {
  const { data: projects } = projectCollectionUtils.useAll();
  const currentUserId = authenticationSession.getCurrentUserId();
  const defaultProject =
    projects.find(
      (project) =>
        project.type === ProjectType.PERSONAL &&
        project.ownerId === currentUserId,
    ) ?? projects[0];
  return { projects, defaultProject };
}

type ChatProjectPickerProps = {
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  locked: boolean;
  disabled?: boolean;
};
