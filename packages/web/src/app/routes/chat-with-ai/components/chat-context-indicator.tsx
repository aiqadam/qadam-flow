import { ChatContextUsage, chatContextUtils, isNil } from '@aiqadam/shared';
import { t } from 'i18next';
import { Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';

// How full the model's context was on the last reply, and what filled it. The total is the
// provider's own count; the parts are the server's estimate, scaled to add up to it
// (`chat-context-usage.ts`). Nothing is shown before a reply has been measured — a guessed number
// here would read as a measurement.
export function ChatContextIndicator({
  usage,
  hasReply,
  compaction,
  onAutoCompactChange,
}: ChatContextIndicatorProps) {
  const { i18n } = useTranslation();
  const fill = isNil(usage) ? null : contextFill(usage);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-7 gap-1.5 rounded-full px-3 text-xs font-medium"
        >
          <Gauge className="size-3.5 text-muted-foreground shrink-0" />
          <span>
            {isNil(fill)
              ? t('Context')
              : t('Context · {percent}%', { percent: fill.percent })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="start">
        {isNil(usage) || isNil(fill) ? (
          <p className="text-sm font-medium">{t('Model context')}</p>
        ) : (
          <p className="text-sm break-words">
            <span className="font-medium">{t('Model context')}</span>
            <span className="text-muted-foreground">
              {' · '}
              {isNil(usage.contextWindowTokens)
                ? t('{model} · window not set, assuming {tokens}', {
                    model: usage.modelId,
                    tokens: formatTokens({
                      tokens: fill.windowTokens,
                      locale: i18n.language,
                    }),
                  })
                : t('{model} · window {tokens}', {
                    model: usage.modelId,
                    tokens: formatTokens({
                      tokens: fill.windowTokens,
                      locale: i18n.language,
                    }),
                  })}
            </span>
          </p>
        )}
        {isNil(usage) || isNil(fill) ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {hasReply
              ? t(
                  'No measurement for the last reply. It appears after the next one, if the provider reports token usage.',
                )
              : t('Shows up once a reply finishes.')}
          </p>
        ) : (
          <ContextBreakdown
            usage={usage}
            fill={fill}
            locale={i18n.language}
            compaction={compaction}
          />
        )}
        <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="chat-auto-compact" className="text-sm font-medium">
              {t('Auto-compact')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {compaction.autoCompact
                ? t(
                    'Older messages are summarised for the model when the context fills up.',
                  )
                : t(
                    'Older messages are dropped, not summarised, when the context fills up.',
                  )}
            </p>
          </div>
          <Switch
            id="chat-auto-compact"
            checked={compaction.autoCompact}
            onCheckedChange={onAutoCompactChange}
            disabled={isNil(onAutoCompactChange)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Marks where the transcript the model is sent begins, so what it no longer sees verbatim is visible
// as such in the conversation itself.
export function ContextWindowDivider({ summarized }: { summarized: boolean }) {
  return (
    <div className="flex items-center gap-3 py-4 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <span>
        {summarized
          ? t('Messages above are summarised for the model')
          : t('Messages above are no longer sent to the model')}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ContextBreakdown({
  usage,
  fill,
  locale,
  compaction,
}: {
  usage: ChatContextUsage;
  fill: ContextFill;
  locale: string;
  compaction: ChatCompactionView;
}) {
  const { breakdown } = usage;
  const format = (tokens: number) => formatTokens({ tokens, locale });
  const untilCompact = Math.max(
    0,
    chatContextUtils.contextBudget(usage).compactAtTokens - usage.usedTokens,
  );
  return (
    <div className="mt-3 space-y-3">
      <div className="space-y-1.5">
        <Progress
          value={fill.percent}
          aria-label={t('Model context')}
          indicatorClassName={fill.percent >= 90 ? 'bg-destructive' : undefined}
        />
        <p className="text-xs text-muted-foreground">
          {t('{used} of {total} · {percent}%', {
            used: format(usage.usedTokens),
            total: format(fill.windowTokens),
            percent: fill.percent,
          })}
        </p>
      </div>
      <dl className="space-y-1 text-sm">
        <BreakdownRow
          label={t('System prompt')}
          value={format(breakdown.systemPrompt)}
        />
        <BreakdownRow
          label={t(
            'Tools ({count, plural, one {# schema} other {# schemas}})',
            { count: breakdown.toolCount },
          )}
          value={format(breakdown.tools)}
        />
        {(breakdown.summary ?? 0) > 0 && (
          <BreakdownRow
            label={t('Summary')}
            value={format(breakdown.summary ?? 0)}
          />
        )}
        <BreakdownRow
          label={t('Messages')}
          value={format(breakdown.messages)}
        />
        <BreakdownRow
          label={t('Tool outputs')}
          value={format(breakdown.toolOutputs)}
        />
        <BreakdownRow
          label={t('Free')}
          value={format(fill.freeTokens)}
          isEstimate={false}
        />
      </dl>
      <p className="text-sm">
        {compaction.autoCompact
          ? untilCompact > 0
            ? t('Until auto-compact ≈ {compact} · until overflow {free}', {
                compact: format(untilCompact),
                free: format(fill.freeTokens),
              })
            : t('Compacts after this reply · until overflow {free}', {
                free: format(fill.freeTokens),
              })
          : t('Auto-compact off · until overflow {free}', {
              free: format(fill.freeTokens),
            })}
      </p>
      {compaction.compactedSinceMeasured && (
        <p className="text-xs text-muted-foreground">
          {t(
            'History was compacted after this reply. The figures update after the next one.',
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          'The total is what the provider counted. The parts are estimated from their share of what was sent.',
        )}
      </p>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  isEstimate = true,
}: {
  label: string;
  value: string;
  isEstimate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
      <dd className="shrink-0 font-mono tabular-nums">
        {isEstimate ? '≈ ' : ''}
        {value}
      </dd>
    </div>
  );
}

function contextFill(usage: ChatContextUsage): ContextFill {
  const { windowTokens } = chatContextUtils.contextBudget(usage);
  return {
    windowTokens,
    freeTokens: Math.max(0, windowTokens - usage.usedTokens),
    // Capped: with an assumed window a conversation can outgrow it, and a bar past 100% says
    // nothing the number beside it does not.
    percent: Math.min(100, Math.round((usage.usedTokens / windowTokens) * 100)),
  };
}

// "81k", "1.2M" in every language, as agreed for this popover, rather than `Intl`'s compact
// notation: that reads "81 тыс." in Russian and "200 м." in Kazakh, which is ambiguous. Only the
// digits are localised.
function formatTokens({
  tokens,
  locale,
}: {
  tokens: number;
  locale: string;
}): string {
  const digits = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  // Chosen on the rounded value, so 999,960 reads "1M" rather than "1,000k".
  if (Math.round(tokens / 100_000) >= 10)
    return `${digits(tokens / 1_000_000)}M`;
  if (Math.round(tokens / 100) >= 10) return `${digits(tokens / 1_000)}k`;
  return digits(tokens);
}

type ContextFill = {
  windowTokens: number;
  freeTokens: number;
  percent: number;
};

type ChatCompactionView = {
  autoCompact: boolean;
  // The transcript's start moved past where the shown measurement began, so its figures describe
  // a longer history than the next turn will send.
  compactedSinceMeasured: boolean;
};

type ChatContextIndicatorProps = {
  usage: ChatContextUsage | null;
  hasReply: boolean;
  compaction: ChatCompactionView;
  onAutoCompactChange?: (autoCompact: boolean) => void;
};
