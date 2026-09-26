import { t } from 'i18next';
import { TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useBuilderStateContext } from '../../builder-hooks';

import LargeWidgetWrapper from './large-widget-wrapper';

const FlowUpdatesHaltedWidget = () => {
  const queueHalted = useBuilderStateContext((state) => state.queueHalted);
  if (!queueHalted) {
    return null;
  }
  return (
    <LargeWidgetWrapper containerClassName="border-destructive">
      <>
        <div className="flex items-center gap-2 min-w-0">
          <TriangleAlert className="size-5 shrink-0 text-destructive" />
          <span>
            {t(
              'A change failed to save, so later changes are no longer saved. Refresh the page to load the saved flow.',
            )}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          {t('Refresh')}
        </Button>
      </>
    </LargeWidgetWrapper>
  );
};

FlowUpdatesHaltedWidget.displayName = 'FlowUpdatesHaltedWidget';
export { FlowUpdatesHaltedWidget };
