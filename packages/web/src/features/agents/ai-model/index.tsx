import { AIProviderName, isNil } from '@aiqadam/shared';
import { t } from 'i18next';
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import * as React from 'react';

import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { aiModelHooks } from './hooks';
import { AIProviderOption, aiProviderOptions } from './provider-options';

export function AIModelSelector({
  defaultProviderId,
  defaultProvider,
  defaultModel,
  disabled = false,
  onChange,
}: AIModelSelectorProps) {
  const [providerOpen, setProviderOpen] = React.useState(false);
  const [modelOpen, setModelOpen] = React.useState(false);
  const [pickedProviderId, setPickedProviderId] = React.useState<
    string | undefined
  >(undefined);
  const [selectedModel, setSelectedModel] = React.useState<string | undefined>(
    defaultModel,
  );

  const { data: providers = [], isLoading: providersLoading } =
    aiModelHooks.useListProviders();

  const options = React.useMemo(
    () => aiProviderOptions.build({ providers }),
    [providers],
  );
  const selectedOption = aiProviderOptions.resolveSelected({
    options,
    selectedProviderId: pickedProviderId,
    defaultProviderId,
    defaultProvider,
  });

  const { data: models = [], isLoading: modelsLoading } =
    aiModelHooks.useGetModelsForProvider({
      providerId: selectedOption?.id,
      provider: selectedOption?.provider,
    });

  // Reconciles the stored model with the catalogue the server answers with, which only arrives
  // after render: a step can hold no model at all, or one this provider no longer serves, and
  // either leaves it unrunnable. Selecting a provider row is a user interaction and lives in
  // `handleProviderChange`; this is the one part that cannot, because it is waiting on a fetch.
  React.useEffect(() => {
    if (isNil(selectedOption) || modelsLoading || models.length === 0) {
      return;
    }
    if (!isNil(selectedModel) && models.some((m) => m.id === selectedModel)) {
      return;
    }
    const fallback = models[0].id;
    setSelectedModel(fallback);
    onChange({
      providerId: selectedOption.id,
      provider: selectedOption.provider,
      model: fallback,
    });
  }, [models, modelsLoading, selectedOption, selectedModel, onChange]);

  const handleProviderChange = (option: AIProviderOption) => {
    setPickedProviderId(option.id);
    setSelectedModel(undefined);
    onChange({
      providerId: option.id,
      provider: option.provider,
      model: undefined,
    });
    setProviderOpen(false);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    onChange({
      providerId: selectedOption?.id,
      provider: selectedOption?.provider,
      model: modelId,
    });
    setModelOpen(false);
  };

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">{t('AI Model *')}</h2>

      <div className="flex items-stretch border rounded-md bg-background overflow-hidden">
        <Popover open={providerOpen} onOpenChange={setProviderOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={providerOpen}
              className="flex-1 justify-between border-0 rounded-none focus-visible:ring-1 focus-visible:ring-offset-0 max-w-72 h-auto"
              disabled={disabled || providersLoading || options.length === 0}
            >
              {providersLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t('Loading...')}</span>
                </div>
              ) : selectedOption ? (
                <AIProviderOptionLabel option={selectedOption} />
              ) : (
                <span className="text-muted-foreground">
                  {options.length === 0
                    ? t('No providers')
                    : t('Select provider')}
                </span>
              )}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 w-[var(--radix-popover-trigger-width)]"
            align="start"
          >
            <Command>
              <CommandInput placeholder={t('Search providers...')} />
              <CommandEmpty>{t('No provider found.')}</CommandEmpty>
              <CommandGroup className="max-h-64 overflow-auto">
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    // The row id, because cmdk both filters and selects on `value` and two custom
                    // rows can carry the same display name. `keywords` is what the search reads,
                    // so typing a name or a base url still finds the entry.
                    value={option.id}
                    keywords={option.searchKeywords}
                    onSelect={() => handleProviderChange(option)}
                    className="cursor-pointer"
                  >
                    <AIProviderOptionLabel option={option} />
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        selectedOption?.id === option.id
                          ? 'opacity-100'
                          : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </Command>
          </PopoverContent>
        </Popover>

        <div className="w-px bg-border self-stretch" />

        <Popover open={modelOpen} onOpenChange={setModelOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={modelOpen}
              className="flex-1 justify-between border-0 rounded-none focus-visible:ring-1 focus-visible:ring-offset-0 min-w-32 h-auto"
              disabled={
                disabled ||
                isNil(selectedOption) ||
                modelsLoading ||
                models.length === 0
              }
            >
              {modelsLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t('Loading...')}</span>
                </div>
              ) : selectedModel ? (
                <span className="truncate">
                  {models.find((m) => m.id === selectedModel)?.name ??
                    selectedModel}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {isNil(selectedOption)
                    ? t('Select provider first')
                    : models.length === 0
                    ? t('No models')
                    : t('Select model')}
                </span>
              )}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 w-[var(--radix-popover-trigger-width)]"
            align="start"
          >
            <Command>
              <CommandInput placeholder={t('Search models...')} />
              <CommandEmpty>{t('No model found.')}</CommandEmpty>
              <CommandGroup className="max-h-64 overflow-auto">
                {models.map((model) => (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => handleModelChange(model.id)}
                    className="cursor-pointer"
                  >
                    <span className="flex-1">{model.name}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        selectedModel === model.id
                          ? 'opacity-100'
                          : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {selectedOption && (
        <p className="text-xs text-muted-foreground">
          {PROVIDER_EMBEDDING_MODELS[selectedOption.provider]
            ? t('Embedding model for knowledge base: {model}', {
                model: PROVIDER_EMBEDDING_MODELS[selectedOption.provider],
              })
            : t('This provider does not support knowledge base embeddings.')}
        </p>
      )}
    </div>
  );
}

function AIProviderOptionLabel({ option }: AIProviderOptionLabelProps) {
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {option.logoUrl && (
        <img
          src={option.logoUrl}
          alt={option.provider}
          className="h-4 w-4 object-contain"
        />
      )}
      <div className="flex flex-col items-start min-w-0">
        <TextWithTooltip tooltipMessage={option.name}>
          <div className="max-w-full">{option.name}</div>
        </TextWithTooltip>
        {option.baseUrl && (
          <TextWithTooltip tooltipMessage={option.baseUrl}>
            <div className="max-w-full text-xs font-normal text-muted-foreground">
              {option.baseUrl}
            </div>
          </TextWithTooltip>
        )}
      </div>
    </div>
  );
}

export const PROVIDER_EMBEDDING_MODELS: Partial<
  Record<AIProviderName, string>
> = {
  [AIProviderName.OPENAI]: 'text-embedding-3-small',
  [AIProviderName.GOOGLE]: 'text-embedding-004',
  [AIProviderName.AZURE]: 'text-embedding-3-small',
  [AIProviderName.OPENROUTER]: 'openai/text-embedding-3-small',
};

type AIModelSelectorProps = {
  /**
   * The row the step is pinned to, when it carries one. Optional forever: steps stored before
   * id-addressing hold only a provider name, and that name still resolves.
   */
  defaultProviderId?: string;
  defaultProvider?: AIProviderName;
  defaultModel?: string;
  disabled?: boolean;
  onChange: (value: {
    providerId?: string;
    provider?: string;
    model?: string;
  }) => void;
};

type AIProviderOptionLabelProps = {
  option: AIProviderOption;
};
