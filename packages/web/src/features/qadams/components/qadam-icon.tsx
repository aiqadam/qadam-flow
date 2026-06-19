import { VariantProps, cva } from 'class-variance-authority';
import React from 'react';

import { ImageWithColorBackground } from '@/components/custom/image-with-color-background';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const qadamIconVariants = cva(
  'flex rounded-md items-center justify-center bg-background  ',
  {
    variants: {
      size: {
        xxl: 'size-[64px] min-w-[64px] min-h-[64px]',
        xl: 'size-[48px] min-w-[48px] min-h-[48px]',
        lg: 'size-[40px] min-w-[40px] min-h-[40px]',
        md: 'size-[36px] min-w-[36px] min-h-[36px]',
        sm: 'size-[30px] min-w-[30px] min-h-[30px]',
        xs: 'size-[25px] min-w-[25px] min-h-[25px]',
        xxs: 'size-[16px] min-w-[16px] min-h-[16px]',
      },
      border: {
        true: 'border border-solid',
      },
    },
    defaultVariants: {},
  },
);

const qadamIconVariantsWithPadding = cva('', {
  variants: {
    size: {
      xxl: 'p-4',
      xl: 'p-3',
      lg: 'p-2',
      md: 'p-1.75',
      sm: 'p-1.25',
      xs: 'p-1.25',
      xxs: 'p-0.5',
    },
  },
});

interface QadamIconProps extends VariantProps<typeof qadamIconVariants> {
  displayName?: string;
  logoUrl?: string;
  showTooltip: boolean;
  background?: string;
}

const QadamIcon = React.memo(
  ({
    displayName,
    logoUrl,
    border,
    size,
    showTooltip,
    background,
  }: QadamIconProps) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              qadamIconVariants({ border, size }),
              'overflow-hidden',
            )}
            style={background ? { backgroundColor: background } : undefined}
          >
            {logoUrl ? (
              <ImageWithColorBackground
                src={logoUrl}
                alt={displayName}
                className={cn(
                  qadamIconVariantsWithPadding({ size }),
                  'object-contain w-full h-full',
                )}
                key={logoUrl}
                fallback={<Skeleton className="rounded-md w-full h-full" />}
              />
            ) : (
              <Skeleton className="rounded-md w-full h-full" />
            )}
          </div>
        </TooltipTrigger>
        {showTooltip ? (
          <TooltipContent side="bottom">{displayName}</TooltipContent>
        ) : null}
      </Tooltip>
    );
  },
);

QadamIcon.displayName = 'QadamIcon';
export { QadamIcon };
