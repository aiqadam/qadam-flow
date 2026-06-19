import {
  FlowTrigger,
  FlowActionType,
  flowStructureUtil,
  QadamCategory,
} from '@aiqadam/shared';
import { cva } from 'class-variance-authority';
import { t } from 'i18next';
import { useMemo } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../../components/ui/tooltip';
import { qadamsHooks } from '../hooks/qadams-hooks';
import { StepMetadata } from '../types';
import { extractQadamNamesAndCoreMetadata } from '../utils/step-utils';

import { QadamIcon } from './qadam-icon';

const extraIconVariants = cva(
  'flex items-center justify-center rounded-md bg-background border border-solid text-xs select-none',
  {
    variants: {
      size: {
        xxl: 'size-[64px]',
        xl: 'size-[48px]',
        lg: 'size-[40px]',
        md: 'size-[38px]',
        sm: 'size-[25px]',
        xs: 'size-[25px]',
      },
    },
  },
);

export function QadamIconList({
  maxNumberOfIconsToShow,
  trigger,
  size,
  className,
  background,
  excludeCore = false,
}: {
  trigger: FlowTrigger;
  maxNumberOfIconsToShow: number;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
  className?: string;
  background?: string;
  excludeCore?: boolean;
}) {
  const steps = flowStructureUtil.getAllSteps(trigger);

  const { qadamNames, coreMetadata } = useMemo(
    () => extractQadamNamesAndCoreMetadata(steps, excludeCore),
    [steps, excludeCore],
  );

  const { summaries } = qadamsHooks.useQadamSummariesByNames({
    names: qadamNames,
  });

  const stepsMetadata: StepMetadata[] = useMemo(() => {
    const qadamMetadata: StepMetadata[] = summaries
      .filter(
        (piece) =>
          !excludeCore || !piece.categories?.includes(QadamCategory.CORE),
      )
      .map((piece) => ({
        displayName: piece.displayName,
        logoUrl: piece.logoUrl,
        description: piece.description,
        type: FlowActionType.PIECE as const,
        qadamType: piece.qadamType,
        qadamName: piece.name,
        qadamVersion: piece.version,
        categories: piece.categories ?? [],
        packageType: piece.packageType,
        auth: piece.auth,
      }));
    return [...coreMetadata, ...qadamMetadata];
  }, [summaries, coreMetadata, excludeCore]);

  const uniqueMetadata: StepMetadata[] = stepsMetadata.filter(
    (item, index, self) =>
      self.findIndex(
        (secondItem) => item.displayName === secondItem.displayName,
      ) === index,
  );
  const visibleMetadata = uniqueMetadata.slice(0, maxNumberOfIconsToShow);
  const extraQadams = uniqueMetadata.length - visibleMetadata.length;
  const extraMetadata = uniqueMetadata.slice(maxNumberOfIconsToShow);

  return (
    <div className={className || 'flex gap-0.5 '}>
      {visibleMetadata.map((metadata) => (
        <QadamIcon
          logoUrl={metadata.logoUrl}
          showTooltip={true}
          size={size ?? 'md'}
          border={true}
          displayName={metadata.displayName}
          key={metadata.displayName}
          background={background}
        />
      ))}
      {extraQadams > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={extraIconVariants({ size: size ?? 'xs' })}>
              +{extraQadams}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {extraMetadata.length > 1 &&
              extraMetadata
                .map((m) => m?.displayName || '')
                .slice(0, -1)
                .join(', ') +
                ` ${t('and')} ${
                  extraMetadata[extraMetadata.length - 1].displayName
                }`}
            {extraMetadata.length === 1 && extraMetadata[0].displayName}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
