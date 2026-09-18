import { AIProviderModel, isNil } from '@aiqadam/shared';
import { t } from 'i18next';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import * as React from 'react';

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
import { aiModelHooks } from '@/features/agents/ai-model/hooks';
import { cn } from '@/lib/utils';

export function ChatModelPicker({
  modelName,
  onModelChange,
  disabled = false,
}: ChatModelPickerProps) {
  const [open, setOpen] = React.useState(false);

  const { data: providers = [] } = aiModelHooks.useListProviders();
  const chatProvider = providers.find((provider) => provider.enabledForChat);

  const { data: models = [] } = aiModelHooks.useGetModelsForProvider({
    row: chatProvider,
  });

  // The zero-config fallback (`chatModel.resolve`'s first-text-model pick) has to keep working for
  // anyone who never opens this control, so there is never a wrong state to render here — only
  // "nothing to pick from yet", which is the same as not showing a picker at all.
  if (isNil(chatProvider) || models.length === 0) {
    return null;
  }

  const selectedModel = models.find((model) => model.id === modelName);

  const handleSelect = (model: AIProviderModel) => {
    onModelChange(model.id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-7 gap-1.5 rounded-full px-3 text-xs font-medium"
        >
          <Cpu className="size-3.5 text-muted-foreground shrink-0" />
          <span className="max-w-32 truncate">
            {/* A pinned `modelName` that this allow-listed dropdown doesn't carry (e.g. picked
              before an allow-list change) is still the model the run actually uses — showing
              "Auto" there would claim no explicit choice was made. */}
            {selectedModel ? selectedModel.name : modelName ?? t('Auto')}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-64" align="start">
        <Command>
          <CommandInput placeholder={t('Search models...')} />
          <CommandEmpty>{t('No model found.')}</CommandEmpty>
          <CommandGroup className="max-h-64 overflow-auto">
            {models.map((model) => (
              <CommandItem
                key={model.id}
                value={model.id}
                onSelect={() => handleSelect(model)}
                className="cursor-pointer"
              >
                <span className="flex-1 truncate">{model.name}</span>
                <Check
                  className={cn(
                    'ml-auto h-4 w-4',
                    selectedModel?.id === model.id
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
  );
}

type ChatModelPickerProps = {
  modelName: string | null;
  onModelChange: (modelName: string) => void;
  disabled?: boolean;
};
