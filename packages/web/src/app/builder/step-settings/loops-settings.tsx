import {
  isNil,
  LoopExecutionMode,
  LoopIterationFailurePolicy,
  LOOP_MAX_CONCURRENCY,
  LoopKeepBodies,
  LoopOnItemsAction,
  LoopRateLimitedPolicy,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { Gauge, ListChecks } from 'lucide-react';
import React, { useState } from 'react';
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
import { Input } from '@/components/ui/input';
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

import { loopSettingsUtils } from './loop-settings-utils';

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
      <LoopExecutionSettingsForm readonly={readonly} />
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
                  // The step is saved from the form resolver, which runs only on validation.
                  { shouldDirty: true, shouldValidate: true },
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
                  {t('Items where any step failed')}
                </SelectItem>
                <SelectItem value={LoopKeepBodies.NONE}>
                  {t('Only items that did not finish')}
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

// #387 / #374: how iterations run — concurrently, at a declared rate, and what a failed item does.
const LoopExecutionSettingsForm = ({ readonly }: LoopsSettingsProps) => {
  const form = useFormContext<LoopOnItemsAction>();
  const execution = form.watch('settings.execution');
  const mode = execution?.mode ?? LoopExecutionMode.SEQUENTIAL;
  const rateLimited = !isNil(execution?.rateLimit);
  const continuing =
    execution?.onIterationFailure === LoopIterationFailurePolicy.CONTINUE;
  const update = (patch: Partial<NonNullable<typeof execution>>) =>
    form.setValue(
      'settings.execution',
      { mode, ...execution, ...patch },
      { shouldDirty: true, shouldValidate: true },
    );

  return (
    <div className={cn('flex flex-col mt-2', GAP_SIZE_FOR_STEP_SETTINGS)}>
      <div className="text-xs font-semibold tracking-wide text-muted-foreground flex items-center gap-1">
        <Gauge className="w-4 h-4" />
        <span>{t('Execution')}</span>
      </div>
      <FormItem className="flex flex-col gap-2">
        <FormLabel>{t('Run items')}</FormLabel>
        <Select
          disabled={readonly}
          value={mode}
          onValueChange={(value) =>
            update({
              mode:
                value === LoopExecutionMode.CONCURRENT
                  ? LoopExecutionMode.CONCURRENT
                  : LoopExecutionMode.SEQUENTIAL,
            })
          }
        >
          <FormControl>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            <SelectItem value={LoopExecutionMode.SEQUENTIAL}>
              {t('One at a time')}
            </SelectItem>
            <SelectItem value={LoopExecutionMode.CONCURRENT}>
              {t('Several at once')}
            </SelectItem>
          </SelectContent>
        </Select>
        {mode === LoopExecutionMode.CONCURRENT && (
          <ReadMoreDescription
            text={t(
              'Speeds up steps that wait on another service. Steps that pause the run, like a long Delay or an approval, cannot run inside this loop.',
            )}
          />
        )}
      </FormItem>
      {mode === LoopExecutionMode.CONCURRENT && (
        <FormField
          control={form.control}
          name="settings.execution.maxConcurrency"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-2">
              <FormLabel>{t('Items at a time')}</FormLabel>
              <BoundedNumberInput
                disabled={readonly}
                value={field.value}
                placeholder="10"
                bounds={{ min: 1, max: LOOP_MAX_CONCURRENCY, integer: true }}
                allowEmpty
                onCommit={(maxConcurrency) => update({ maxConcurrency })}
              />
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      <FormItem>
        <FormLabel
          htmlFor="loopRateLimit"
          className="flex items-center gap-1 h-7.5 max-h-7.5"
        >
          <FormControl>
            <Switch
              disabled={readonly}
              id="loopRateLimit"
              checked={rateLimited}
              onCheckedChange={(checked) =>
                update({
                  rateLimit: checked ? { count: 10, perSeconds: 1 } : undefined,
                })
              }
            />
          </FormControl>
          <span className="ml-2">{t('Limit the rate')}</span>
        </FormLabel>
        <ReadMoreDescription
          text={t(
            'Starts items no faster than the rate you set, and pauses every item when the service asks to slow down.',
          )}
        />
      </FormItem>
      {rateLimited && (
        <div className="flex gap-2">
          <FormField
            control={form.control}
            name="settings.execution.rateLimit.count"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-2 flex-1">
                <FormLabel>{t('Items')}</FormLabel>
                <BoundedNumberInput
                  disabled={readonly}
                  value={field.value}
                  bounds={{ min: 1, max: 10000, integer: true }}
                  onCommit={(count) =>
                    update({
                      rateLimit: {
                        count: count ?? 1,
                        perSeconds: execution?.rateLimit?.perSeconds ?? 1,
                      },
                    })
                  }
                />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="settings.execution.rateLimit.perSeconds"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-2 flex-1">
                <FormLabel>{t('Per seconds')}</FormLabel>
                <BoundedNumberInput
                  disabled={readonly}
                  value={field.value}
                  bounds={{
                    min: 0,
                    max: 86400,
                    integer: false,
                    exclusiveMin: true,
                  }}
                  onCommit={(perSeconds) =>
                    update({
                      rateLimit: {
                        count: execution?.rateLimit?.count ?? 1,
                        perSeconds: perSeconds ?? 1,
                      },
                    })
                  }
                />
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}
      {rateLimited && (
        <FormItem>
          <FormLabel
            htmlFor="loopWaitWhenRateLimited"
            className="flex items-center gap-1 h-7.5 max-h-7.5"
          >
            <FormControl>
              <Switch
                disabled={readonly}
                id="loopWaitWhenRateLimited"
                checked={
                  execution?.onRateLimited !== LoopRateLimitedPolicy.FAIL
                }
                onCheckedChange={(checked) =>
                  update({
                    onRateLimited: checked
                      ? LoopRateLimitedPolicy.WAIT_AND_RETRY
                      : LoopRateLimitedPolicy.FAIL,
                  })
                }
              />
            </FormControl>
            <span className="ml-2">
              {t('Wait and retry when the service asks to slow down')}
            </span>
          </FormLabel>
        </FormItem>
      )}
      <FormItem>
        <FormLabel
          htmlFor="loopDurable"
          className="flex items-center gap-1 h-7.5 max-h-7.5"
        >
          <FormControl>
            <Switch
              disabled={readonly}
              id="loopDurable"
              checked={execution?.durable === true}
              onCheckedChange={(checked) => update({ durable: checked })}
            />
          </FormControl>
          <span className="ml-2">{t('Continue past the run time limit')}</span>
        </FormLabel>
        <ReadMoreDescription
          text={t(
            'Before the run runs out of time, the loop pauses between items and continues with a fresh time budget, so it can work through more items than fit in one run. An item that was running when the run was stopped some other way may be sent again on retry.',
          )}
        />
      </FormItem>
      <FormItem className="flex flex-col gap-2">
        <FormLabel>{t('When an item fails')}</FormLabel>
        <Select
          disabled={readonly}
          value={
            continuing
              ? LoopIterationFailurePolicy.CONTINUE
              : LoopIterationFailurePolicy.STOP
          }
          onValueChange={(value) =>
            update({
              onIterationFailure:
                value === LoopIterationFailurePolicy.CONTINUE
                  ? LoopIterationFailurePolicy.CONTINUE
                  : LoopIterationFailurePolicy.STOP,
            })
          }
        >
          <FormControl>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            <SelectItem value={LoopIterationFailurePolicy.STOP}>
              {t('Stop the loop')}
            </SelectItem>
            <SelectItem value={LoopIterationFailurePolicy.CONTINUE}>
              {t('Continue with the other items')}
            </SelectItem>
          </SelectContent>
        </Select>
      </FormItem>
      {continuing && (
        <FormItem>
          <FormLabel
            htmlFor="loopTolerateFailures"
            className="flex items-center gap-1 h-7.5 max-h-7.5"
          >
            <FormControl>
              <Switch
                disabled={readonly}
                id="loopTolerateFailures"
                checked={execution?.tolerateFailures === true}
                onCheckedChange={(checked) =>
                  update({ tolerateFailures: checked })
                }
              />
            </FormControl>
            <span className="ml-2">
              {t('Keep running the flow when items fail')}
            </span>
          </FormLabel>
          <ReadMoreDescription
            text={t(
              'Otherwise the loop fails once every item was tried. Turn this on to handle the failures in later steps, using failures on the loop output.',
            )}
          />
        </FormItem>
      )}
    </div>
  );
};

// Keeps what the user types as text and commits only a value the API accepts; an out-of-range
// value is shown as an error in place instead of being saved.
function BoundedNumberInput({
  value,
  onCommit,
  bounds,
  allowEmpty = false,
  disabled,
  placeholder,
}: {
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  bounds: {
    min: number;
    max: number;
    integer: boolean;
    exclusiveMin?: boolean;
  };
  allowEmpty?: boolean;
  disabled: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(isNil(value) ? '' : String(value));
  const blank = loopSettingsUtils.isBlank(text);
  const invalid =
    (!blank || !allowEmpty) && !loopSettingsUtils.isValid({ text, ...bounds });
  return (
    <>
      <Input
        disabled={disabled}
        type="number"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = loopSettingsUtils.parseBoundedNumber({
            text: next,
            ...bounds,
          });
          if (!isNil(parsed)) {
            onCommit(parsed);
          } else if (allowEmpty && loopSettingsUtils.isBlank(next)) {
            onCommit(undefined);
          }
        }}
      />
      {invalid && (
        <p className="text-xs text-destructive">
          {bounds.integer
            ? t('Enter a whole number from {min} to {max}', {
                min: bounds.min,
                max: bounds.max,
              })
            : t('Enter a number above {min} and up to {max}', {
                min: bounds.min,
                max: bounds.max,
              })}
        </p>
      )}
    </>
  );
}

export { LoopsSettings };
