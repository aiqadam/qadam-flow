import { isObject } from '@aiqadam/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';

import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  AnyToolPart,
  ThinkingStep,
  chatPartUtils,
} from '@/features/chat/lib/chat-types';
import { chatUtils } from '@/features/chat/lib/chat-utils';
import { QadamIcon } from '@/features/qadams/components/qadam-icon';
import { qadamsHooks } from '@/features/qadams/hooks/qadams-hooks';

export function ToolShimmerPills({
  toolSteps,
  lastThinkingStatus,
}: {
  toolSteps: Array<ThinkingStep & { kind: 'tool' }>;
  lastThinkingStatus: string | null;
}) {
  const lastStep =
    toolSteps.length > 0 ? toolSteps[toolSteps.length - 1] : null;

  const qadamNames = useMemo(() => {
    if (!lastStep) return [];
    const input = isObject(lastStep.part.input)
      ? (lastStep.part.input as Record<string, unknown>)
      : undefined;
    return chatPartUtils.extractQadamNames(input);
  }, [lastStep]);

  const { summaries: pieceSummaries } = qadamsHooks.useQadamSummariesByNames({
    names: qadamNames,
  });

  const description = lastThinkingStatus ?? lastStep?.description;

  return (
    <AnimatePresence mode="wait">
      {lastStep && (
        <motion.div
          key={lastStep.part.toolCallId}
          className="pt-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          {description && (
            <p className="text-sm text-muted-foreground mb-1.5">
              {description}
            </p>
          )}
          <ShimmerPill part={lastStep.part} pieceSummaries={pieceSummaries} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ShimmerPill({
  part,
  pieceSummaries,
}: {
  part: AnyToolPart;
  pieceSummaries: Array<{
    name: string;
    displayName: string;
    logoUrl?: string;
  }>;
}) {
  const { activeTitle } = chatPartUtils.extractToolTitles(part);
  const activeFallback = chatUtils.formatToolActionName({ part });
  const label = activeTitle ?? activeFallback;

  const input = isObject(part.input)
    ? (part.input as Record<string, unknown>)
    : undefined;
  const currentPieceNames = useMemo(
    () => chatPartUtils.extractQadamNames(input),
    [input],
  );
  const matchedPieces = pieceSummaries.filter(
    (p) => p.logoUrl && currentPieceNames.includes(p.name),
  );

  const pillClasses =
    'inline-flex items-center gap-2 rounded-lg border border-border px-4 py-1.5 text-sm';

  const icons = matchedPieces.map((piece) => (
    <QadamIcon
      key={piece.name}
      displayName={piece.displayName}
      logoUrl={piece.logoUrl!}
      size="xxs"
      border={false}
      showTooltip={false}
    />
  ));

  return (
    <TextShimmer as="div" className={pillClasses} duration={2}>
      {label}
      {icons}
    </TextShimmer>
  );
}
