import {
  ActionContext,
  createAction,
  NumberProperty,
  QadamAuthProperty,
  Property,
  ShortTextProperty,
  StaticDropdownProperty,
} from '@aiqadam/qadams-framework';
import { common, getScopeAndKey, PieceStoreScope } from './common';
import { z } from 'zod';
import { propsValidation } from '@aiqadam/qadams-common';

async function executePutIfAbsent(context: ActionContext<QadamAuthProperty | undefined, {
  key: ShortTextProperty<true>;
  value: ShortTextProperty<true>;
  store_scope: StaticDropdownProperty<PieceStoreScope, true>;
  ttl_seconds: NumberProperty<false>;
}>, isTestMode = false) {
  await propsValidation.validateZod(context.propsValue, {
    key: z.string().max(128),
  });

  const { key, scope } = getScopeAndKey({
    runId: context.run.id,
    key: context.propsValue['key'],
    scope: context.propsValue.store_scope,
    isTestMode,
  });

  const ttlSeconds = context.propsValue['ttl_seconds'];
  return context.store.putIfAbsent(
    key,
    context.propsValue['value'],
    scope,
    ttlSeconds === null || ttlSeconds === undefined ? undefined : { ttlSeconds },
  );
}

export const storagePutIfAbsentAction = createAction({
  name: 'put_if_absent',
  displayName: 'Put If Absent',
  description: 'Store a value only if the key is not already taken, and report whether this run is the one that took it.',
  errorHandlingOptions: {
    continueOnFailure: {
      hide: true,
    },
    retryOnFailure: {
      hide: true,
    },
  },
  props: {
    key: Property.ShortText({
      displayName: 'Key',
      required: true,
    }),
    value: Property.ShortText({
      displayName: 'Value',
      required: true,
    }),
    store_scope: common.store_scope,
    ttl_seconds: Property.Number({
      displayName: 'Expires After (seconds)',
      description: 'Leave empty to keep the value forever. An expired key is free to be taken again.',
      required: false,
    }),
  },
  async run(context) {
    return executePutIfAbsent(context, false);
  },
  async test(context) {
    return executePutIfAbsent(context, true);
  },
});
