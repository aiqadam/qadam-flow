import { isNil } from '@aiqadam/shared';
import { t } from 'i18next';
import {
  Brain,
  Folder,
  Layers,
  LucideIcon,
  MessagesSquare,
} from 'lucide-react';

import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { getProjectName } from '@/features/projects';

import { useChatProjects } from './chat-project-picker';

// What the next turn will actually send the model. Each row describes the server's real behaviour
// rather than an aspiration: the transcript is a window of the newest messages
// (`chatContextUtils.replayWindowStart`), and `chat-transcript.ts` never replays reasoning. There is
// no row for a summary or for how full the provider's context window is — nothing writes
// `summary` yet, and no provider row records a model's context size, so either row could only
// ever show a placeholder.
export function ChatContextIndicator({
  projectId,
  isProjectLocked,
  totalMessages,
  replayedMessages,
}: ChatContextIndicatorProps) {
  const { projects, defaultProject } = useChatProjects();

  // Same resolution as `ChatProjectPicker`, so the two controls never name different projects.
  const project = isNil(projectId)
    ? isProjectLocked
      ? undefined
      : defaultProject
    : projects.find((candidate) => candidate.id === projectId);
  const isTrimmed = replayedMessages < totalMessages;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-7 gap-1.5 rounded-full px-3 text-xs font-medium"
        >
          <Layers className="size-3.5 text-muted-foreground shrink-0" />
          <span>{t('Context')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="start">
        <p className="text-sm font-medium">{t('What the assistant sees')}</p>
        <div className="mt-3 space-y-3">
          <ContextRow
            icon={Folder}
            label={t('Project')}
            value={isNil(project) ? t('No project') : getProjectName(project)}
          />
          <ContextRow
            icon={MessagesSquare}
            label={t('Messages')}
            value={
              isTrimmed
                ? t('Latest {count} of {total}', {
                    count: replayedMessages,
                    total: totalMessages,
                  })
                : t('{count, plural, =1 {# message} other {All # messages}}', {
                    count: totalMessages,
                  })
            }
            note={
              isTrimmed
                ? t('Older messages are no longer sent to the model.')
                : undefined
            }
          />
          <ContextRow
            icon={Brain}
            label={t('Reasoning')}
            value={t('Current reply only')}
            note={t(
              'Reasoning from earlier replies is not sent back to the model.',
            )}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Marks where the replayed window starts, so the messages the model no longer sees are visible as
// such in the conversation itself rather than only in the popover.
export function ContextWindowDivider() {
  return (
    <div className="flex items-center gap-3 py-4 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <span>{t('Messages above are no longer sent to the model')}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ContextRow({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <TextWithTooltip tooltipMessage={value}>
            <p className="min-w-0 font-medium">{value}</p>
          </TextWithTooltip>
        </div>
        {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

type ChatContextIndicatorProps = {
  projectId: string | null;
  isProjectLocked: boolean;
  totalMessages: number;
  replayedMessages: number;
};
