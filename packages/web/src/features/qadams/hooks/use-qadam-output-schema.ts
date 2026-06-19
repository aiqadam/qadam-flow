import type { OutputSchema } from '@aiqadam/qadams-framework';
import { isNil } from '@aiqadam/shared';

import { qadamsHooks } from './qadams-hooks';

function useQadamOutputSchema({
  qadamName,
  qadamVersion,
  stepName,
}: {
  qadamName?: string;
  qadamVersion?: string;
  stepName?: string;
}): OutputSchema | null {
  const { qadamModel } = qadamsHooks.useQadam({
    name: qadamName ?? '',
    version: qadamVersion,
    enabled: !isNil(qadamName) && !isNil(stepName),
  });

  if (!qadamModel || !stepName) return null;
  const fromTrigger = qadamModel.triggers?.[stepName]?.outputSchema;
  if (fromTrigger) return fromTrigger;
  const fromAction = qadamModel.actions?.[stepName]?.outputSchema;
  if (fromAction) return fromAction;
  return null;
}

export { useQadamOutputSchema };
