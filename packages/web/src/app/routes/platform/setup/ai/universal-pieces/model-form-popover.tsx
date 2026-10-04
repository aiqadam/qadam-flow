import {
  AIProviderModelType,
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  ModelContextWindowTokens,
  ProviderModelConfig,
  spreadIfDefined,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ModelFormPopoverProps = {
  initialData?: ProviderModelConfig;
  onSubmit: (model: ProviderModelConfig) => void;
  children: React.ReactNode;
};

const ModelFormPopover = ({
  initialData,
  onSubmit,
  children,
}: ModelFormPopoverProps) => {
  const [open, setOpen] = useState(false);
  const defaultModel: ProviderModelConfig = {
    modelId: '',
    modelName: '',
    modelType: AIProviderModelType.TEXT,
  };

  const [model, setModel] = useState<ProviderModelConfig>(
    initialData || defaultModel,
  );
  // Kept as the typed text rather than a number, so a half-typed or cleared value is not coerced
  // into something the operator did not enter.
  const [contextWindowText, setContextWindowText] = useState(
    contextWindowToText(initialData?.contextWindowTokens),
  );
  const [contextWindowError, setContextWindowError] = useState<string | null>(
    null,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // so parent form doesn't submit
    e.stopPropagation();
    // Checked here rather than left to the dialog's resolver: the dialog validates `config.models`
    // as a whole and has nowhere to show an error against one model in the list. The input carries
    // no `min`/`max`/`step` for the same reason — the browser would block the submit with its own
    // untranslated tooltip before this could show the translated message.
    // An image model has no context window; whatever was typed before switching type is dropped.
    const contextWindow =
      model.modelType === AIProviderModelType.TEXT
        ? parseContextWindowText(contextWindowText)
        : NO_CONTEXT_WINDOW;
    if (!contextWindow.valid) {
      setContextWindowError(t('contextWindowTokensOutOfRange'));
      return;
    }
    onSubmit({
      modelId: model.modelId,
      modelName: model.modelName,
      modelType: model.modelType,
      ...spreadIfDefined('contextWindowTokens', contextWindow.tokens),
    });
    if (!initialData) {
      setModel(defaultModel);
      setContextWindowText('');
    }
    setContextWindowError(null);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 max-h-(--radix-popover-content-available-height) overflow-y-auto">
        <div className="grid gap-4">
          <div className="space-y-2">
            <h4 className="font-medium leading-none">
              {initialData ? t('Edit Model') : t('Add Model')}
            </h4>
            <p className="text-sm text-muted-foreground">
              {t('Configure the model settings')}
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="modelId">{t('Model ID')}</Label>
              <Input
                id="modelId"
                value={model.modelId}
                onChange={(e) =>
                  setModel({ ...model, modelId: e.target.value })
                }
                placeholder="e.g., gpt-4"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="modelName">{t('Model Name')}</Label>
              <Input
                id="modelName"
                value={model.modelName}
                onChange={(e) =>
                  setModel({ ...model, modelName: e.target.value })
                }
                placeholder="e.g., GPT-4"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="modelType">{t('Model Type')}</Label>
              <Select
                value={model.modelType}
                onValueChange={(value) =>
                  setModel({
                    ...model,
                    modelType: value as AIProviderModelType,
                  })
                }
              >
                <SelectTrigger id="modelType">
                  <SelectValue placeholder={'Select model type'} />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(AIProviderModelType).map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {model.modelType === AIProviderModelType.TEXT && (
              <div className="space-y-2">
                <Label htmlFor="contextWindowTokens">
                  {t('Context window (tokens)')}
                </Label>
                <Input
                  id="contextWindowTokens"
                  type="number"
                  inputMode="numeric"
                  value={contextWindowText}
                  onChange={(e) => {
                    setContextWindowText(e.target.value);
                    setContextWindowError(null);
                  }}
                  placeholder={String(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)}
                  aria-invalid={contextWindowError !== null}
                />
                {contextWindowError ? (
                  <p className="text-sm text-destructive">
                    {contextWindowError}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'Chat uses this to decide when to compact a long conversation. Leave empty to assume {count, plural, one {# token} other {# tokens}}.',
                      {
                        count: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
                      },
                    )}
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit">
                {initialData ? t('Update') : t('Add')}
              </Button>
            </div>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
};

ModelFormPopover.displayName = 'ModelFormPopover';
export { ModelFormPopover };

const NO_CONTEXT_WINDOW: ContextWindowInput = {
  valid: true,
  tokens: undefined,
};

function contextWindowToText(tokens: number | undefined): string {
  return tokens === undefined ? '' : String(tokens);
}

function parseContextWindowText(text: string): ContextWindowInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: true, tokens: undefined };
  }
  const parsed = ModelContextWindowTokens.safeParse(Number(trimmed));
  return parsed.success
    ? { valid: true, tokens: parsed.data }
    : { valid: false };
}

type ContextWindowInput =
  { valid: true; tokens: number | undefined } | { valid: false };
