import { AIProviderWithoutSensitiveData } from '@aiqadam/shared';
import { t } from 'i18next';
import { Pencil, Trash } from 'lucide-react';

import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/custom/item';
import { ItemMediaImage } from '@/components/custom/item-media-image';
import { Button } from '@/components/ui/button';
import { AiProviderInfo } from '@/features/agents';

import { aiProviderRowUtils } from '../ai-provider-rows';

import { UpsertAIProviderDialog } from './upsert-provider-dialog';

const AIProviderCard = ({
  providerInfo,
  providerConfig,
  defaultDisplayName,
  createLabel,
  onDelete,
  onSave,
  allowWrite = true,
}: AIProviderCardProps) => {
  const logoUrl = providerInfo.logoUrl;
  const displayName = providerConfig?.name ?? providerInfo.name;
  const target = aiProviderRowUtils.buildUpsertTarget({ providerConfig });

  return (
    <Item variant="outline">
      {logoUrl && <ItemMediaImage src={logoUrl} alt={providerInfo.name} />}
      <ItemContent>
        <ItemTitle>{displayName}</ItemTitle>
        {allowWrite && (
          <ItemDescription>
            {t('Configure credentials for {providerName} AI provider.', {
              providerName: providerInfo.name,
            })}
          </ItemDescription>
        )}
      </ItemContent>
      {allowWrite && (
        <ItemActions>
          <UpsertAIProviderDialog
            key={providerConfig?.id ?? providerInfo.provider}
            target={target}
            provider={providerInfo.provider}
            defaultDisplayName={defaultDisplayName}
            onSave={onSave}
          >
            {providerConfig ? (
              <Button variant={'ghost'} size={'sm'}>
                <Pencil className="size-4" />
              </Button>
            ) : (
              <Button variant={'basic'} size={'sm'}>
                {createLabel ?? t('Enable')}
              </Button>
            )}
          </UpsertAIProviderDialog>
          {providerConfig && (
            <ConfirmationDeleteDialog
              title={t('Delete AI Provider')}
              message={t('Are you sure you want to delete {providerName}?', {
                providerName: displayName,
              })}
              warning={t(
                'All steps using this AI provider will fail after deletion.',
              )}
              entityName={displayName}
              mutationFn={() => onDelete(providerConfig.id)}
            >
              <Button variant={'ghost'} size={'sm'}>
                <Trash className="size-4 text-destructive" />
              </Button>
            </ConfirmationDeleteDialog>
          )}
        </ItemActions>
      )}
    </Item>
  );
};

type AIProviderCardProps = {
  providerInfo: AiProviderInfo;
  providerConfig?: AIProviderWithoutSensitiveData;
  /** Seeds the dialog's Display Name field; a card's title still comes from the row itself. */
  defaultDisplayName: string;
  /** Label for the button that opens the dialog in create mode. Defaults to "Enable". */
  createLabel?: string;
  onDelete: (id: string) => Promise<void>;
  onSave: () => void;
  allowWrite?: boolean;
};

AIProviderCard.displayName = 'AIProviderCard';
export { AIProviderCard };
