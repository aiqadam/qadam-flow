import { isNil, LoopKeepBodies, LoopOnItemsAction } from '@aiqadam/shared';
import { t } from 'i18next';
import { ListChecks } from 'lucide-react';
import React from 'react';
import { useFormContext } from 'react-hook-form';

import { ApMarkdown } from '@/components/custom/markdown';
import { ReadMoreDescription } from '@/components/custom/read-more-description';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn, GAP_SIZE_FOR_STEP_SETTINGS } from '@/lib/utils';

import { TextInputWithMentions } from '../qadam-properties/text-input-with-mentions';

const markdown = t(
  'Select the items to iterate over from the previous step by clicking on the **Items** input, which should be a **list** of items.\n\nThe loop will iterate over each item in the list and execute the next step for every item.',
);

type LoopsSettingsProps = {
  readonly: boolean;
};

const LoopsSettings = React.memo(({ readonly }: LoopsSettingsProps) => {
  const form = useFormContext<LoopOnItemsAction>();

  return (
    <div className={cn('flex flex-col', GAP_SIZE_FOR_STEP_SETTINGS)}>
      <FormField
        control={form.control}
        name="settings.items"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-2">
            <ApMarkdown markdown={markdown} />
            <FormLabel showRequiredIndicator>{t('Items')}</FormLabel>
            <TextInputWithMentions
              disabled={readonly}
              onChange={field.onChange}
              initialValue={field.value}
              placeholder={t('Select an array of items')}
            ></TextInputWithMentions>
          </FormItem>
        )}
      />
      <LoopResultSettings readonly={readonly} />
    </div>
  );
});

LoopsSettings.displayName = 'LoopsSettings';

// #41: collect one value per iteration instead of walking `iterations` in a CODE step after the loop.
const LoopResultSettings = ({ readonly }: LoopsSettingsProps) => {
  const form = useFormContext<LoopOnItemsAction>();
  const collect = form.watch('settings.collect');
  const collecting = !isNil(collect);

  return (
    <div className={cn('flex flex-col mt-2', GAP_SIZE_FOR_STEP_SETTINGS)}>
      <div className="text-xs font-semibold tracking-wide text-muted-foreground flex items-center gap-1">
        <ListChecks className="w-4 h-4" />
        <span>{t('Results')}</span>
      </div>
      <FormItem>
        <FormLabel
          htmlFor="loopCollect"
          className="flex items-center gap-1 h-7.5 max-h-7.5"
        >
          <FormControl>
            <Switch
              disabled={readonly}
              id="loopCollect"
              checked={collecting}
              onCheckedChange={(checked) =>
                form.setValue(
                  'settings.collect',
                  checked ? { value: '' } : undefined,
                  { shouldDirty: true },
                )
              }
            />
          </FormControl>
          <span className="ml-2">{t('Collect results')}</span>
        </FormLabel>
        <ReadMoreDescription
          text={t(
            'Collects one value per item. After the loop, read the list as collected on the loop output.',
          )}
        />
      </FormItem>
      {collecting && (
        <>
          <FormField
            control={form.control}
            name="settings.collect.value"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-2">
                <FormLabel showRequiredIndicator>
                  {t('Value to collect')}
                </FormLabel>
                <TextInputWithMentions
                  disabled={readonly}
                  onChange={field.onChange}
                  initialValue={field.value}
                  placeholder={t('Select a value from a step inside the loop')}
                ></TextInputWithMentions>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="settings.collect.skipFailed"
            render={({ field }) => (
              <FormItem>
                <FormLabel
                  htmlFor="loopCollectSkipFailed"
                  className="flex items-center gap-1 h-7.5 max-h-7.5"
                >
                  <FormControl>
                    <Switch
                      disabled={readonly}
                      id="loopCollectSkipFailed"
                      checked={field.value === true}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <span className="ml-2">
                    {t('Skip items where a step failed')}
                  </span>
                </FormLabel>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
      <FormField
        control={form.control}
        name="settings.keepBodies"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-2">
            <FormLabel>{t('Keep step details for')}</FormLabel>
            <Select
              disabled={readonly}
              value={field.value ?? LoopKeepBodies.ALL}
              onValueChange={field.onChange}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={LoopKeepBodies.ALL}>
                  {t('Every item')}
                </SelectItem>
                <SelectItem value={LoopKeepBodies.FAILED_ONLY}>
                  {t('Items where a step failed')}
                </SelectItem>
                <SelectItem value={LoopKeepBodies.NONE}>
                  {t('No items')}
                </SelectItem>
              </SelectContent>
            </Select>
            <ReadMoreDescription
              text={t(
                'Keeping fewer details lets a loop over thousands of items stay under the run log size limit. Collected results and failures are kept either way.',
              )}
            />
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
};

export { LoopsSettings };
