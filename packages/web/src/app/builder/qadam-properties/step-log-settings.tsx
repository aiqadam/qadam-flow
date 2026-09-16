import { FlowAction, FlowActionType, FlowTrigger } from '@aiqadam/shared';
import { t } from 'i18next';
import { ScrollText } from 'lucide-react';
import React from 'react';
import { useFormContext } from 'react-hook-form';

import { ReadMoreDescription } from '@/components/custom/read-more-description';
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
} from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { cn, GAP_SIZE_FOR_STEP_SETTINGS } from '@/lib/utils';

const StepLogSettingsForm = React.memo(() => {
  const form = useFormContext<FlowAction | FlowTrigger>();
  const stepType = form.getValues('type') as string;

  if (
    ![
      FlowActionType.CODE,
      FlowActionType.PIECE,
      FlowActionType.LOOP_ON_ITEMS,
      FlowActionType.ROUTER,
    ].includes(stepType as FlowActionType)
  ) {
    return null;
  }

  return (
    <div className={cn('flex flex-col mt-2', GAP_SIZE_FOR_STEP_SETTINGS)}>
      <div className="text-xs font-semibold tracking-wide text-muted-foreground flex items-center gap-1">
        <ScrollText className="w-4 h-4" />
        <span>{t('Logging')}</span>
      </div>
      <FormField
        name="logInput"
        control={form.control}
        render={({ field }) => (
          <FormItem>
            <FormLabel
              htmlFor="logInput"
              className="flex items-center gap-1 h-7.5 max-h-7.5"
            >
              <FormControl>
                <Switch
                  id="logInput"
                  checked={field.value ?? true}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <span className="ml-2">{t('Log input')}</span>
            </FormLabel>
            <ReadMoreDescription
              text={t(
                'Save this step input in the run log. Turn off to hide it.',
              )}
            />
          </FormItem>
        )}
      />
      <FormField
        name="logOutput"
        control={form.control}
        render={({ field }) => (
          <FormItem>
            <FormLabel
              htmlFor="logOutput"
              className="flex items-center gap-1 h-7.5 max-h-7.5"
            >
              <FormControl>
                <Switch
                  id="logOutput"
                  checked={field.value ?? true}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <span className="ml-2">{t('Log output')}</span>
            </FormLabel>
            <ReadMoreDescription
              text={t(
                'Save this step output in the run log. Turn off to hide it. The value still flows to the next step.',
              )}
            />
          </FormItem>
        )}
      />
    </div>
  );
});

StepLogSettingsForm.displayName = 'StepLogSettingsForm';
export { StepLogSettingsForm };
