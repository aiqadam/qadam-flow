import { ApFlagId } from '@aiqadam/shared';
import { t } from 'i18next';
import { GitCommitHorizontal } from 'lucide-react';

import { FormattedDate } from '@/components/custom/formatted-date';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { flagsHooks } from '@/hooks/flags-hooks';

export function SidebarBuildInfo() {
  const { data: commitSha } = flagsHooks.useFlag<string>(
    ApFlagId.BUILD_COMMIT_SHA,
  );
  const { data: buildTimestamp } = flagsHooks.useFlag<string>(
    ApFlagId.BUILD_TIMESTAMP,
  );
  const buildDate = buildTimestamp ? new Date(buildTimestamp) : null;

  if (!commitSha || !buildDate || Number.isNaN(buildDate.getTime())) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        <GitCommitHorizontal className="size-3.5 shrink-0" />
        {t('Local build')}
      </div>
    );
  }

  const shortSha = commitSha.slice(0, 7);

  return (
    <a
      href={`${GITHUB_REPO_URL}/commit/${commitSha}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('View commit {sha} on GitHub', { sha: shortSha })}
      className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <GitCommitHorizontal className="size-3.5 shrink-0" />
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('The commit this build was made from')}</p>
        </TooltipContent>
      </Tooltip>
      <span className="font-mono">{shortSha}</span>
      <span>&middot;</span>
      <FormattedDate date={buildDate} />
    </a>
  );
}

const GITHUB_REPO_URL = 'https://github.com/aiqadam/qadam-flow';
