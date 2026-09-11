import { t } from 'i18next';
import { useFormContext } from 'react-hook-form';

import {
  FormControl,
  FormDescription,
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

/**
 * Delivery mode belongs to the credential, not to the step: these APIs allow one consumer per
 * credential, so two flows sharing a connection must not be able to disagree about how it is
 * consumed. That is why this sits beside the token rather than on the trigger.
 *
 * The list mirrors the server's puller registry (`trigger/long-polling/event-puller-registry.ts`).
 * Keeping the two in step by hand is the weak part of this; the qadam declaring its own supported
 * delivery modes in its metadata is the shape that removes the duplication.
 */
const QADAMS_SUPPORTING_PULL_DELIVERY = ['@aiqadam/qadam-telegram-bot'];

const METADATA_KEY = 'transport';
const WEBHOOK = 'webhook';
const LONG_POLLING = 'long_polling';

type DeliveryModeSettingProps = {
  qadamName: string;
  /** Where the connection's metadata sits in the enclosing form. */
  formPath?: string;
};

const DeliveryModeSetting = ({
  qadamName,
  formPath = 'request.metadata',
}: DeliveryModeSettingProps) => {
  const form = useFormContext();
  if (!QADAMS_SUPPORTING_PULL_DELIVERY.includes(qadamName)) {
    return null;
  }
  return (
    <FormField
      name={`${formPath}.${METADATA_KEY}`}
      control={form.control}
      render={({ field }) => (
        <FormItem className="flex flex-col gap-2">
          <FormLabel>{t('Delivery')}</FormLabel>
          <Select value={field.value ?? WEBHOOK} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value={WEBHOOK}>
                {t('Webhook (the app calls this instance)')}
              </SelectItem>
              <SelectItem value={LONG_POLLING}>
                {t('Long polling (this instance calls the app)')}
              </SelectItem>
            </SelectContent>
          </Select>
          <FormDescription>
            {t(
              'Long polling suits instances the app cannot reach — behind NAT or in a closed network. This instance keeps a request open to the app instead. It applies to every flow using this connection, because the app allows only one consumer per credential.',
            )}
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
};

DeliveryModeSetting.displayName = 'DeliveryModeSetting';
export { DeliveryModeSetting };
