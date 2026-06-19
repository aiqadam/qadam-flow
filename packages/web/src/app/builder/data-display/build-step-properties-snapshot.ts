import { QadamMetadataModel } from '@aiqadam/qadams-framework';
import { isNil } from '@aiqadam/shared';

import { StepPropertySnapshot } from './explanation-prompt';

type BuildStepPropertiesSnapshotParams = {
  qadamModel: QadamMetadataModel | undefined;
  stepKind: 'action' | 'trigger';
  stepName: string | undefined;
  input: Record<string, unknown> | undefined;
};

const MAX_PROPERTIES = 25;

const toSnapshot = ({
  qadamModel,
  stepKind,
  stepName,
  input,
}: BuildStepPropertiesSnapshotParams): StepPropertySnapshot[] => {
  if (isNil(qadamModel) || isNil(stepName)) {
    return [];
  }
  const stepDefinition =
    stepKind === 'trigger'
      ? qadamModel.triggers?.[stepName]
      : qadamModel.actions?.[stepName];
  if (isNil(stepDefinition) || isNil(stepDefinition.props)) {
    return [];
  }
  const properties = Object.entries(stepDefinition.props).slice(
    0,
    MAX_PROPERTIES,
  );
  return properties.map(([name, prop]) => {
    const currentValue = input?.[name];
    return {
      name,
      displayName: prop.displayName,
      description: prop.description,
      type: prop.type,
      required: prop.required,
      defaultValue: prop.defaultValue,
      currentValue,
    };
  });
};

const findStepDescription = ({
  qadamModel,
  stepKind,
  stepName,
}: {
  qadamModel: QadamMetadataModel | undefined;
  stepKind: 'action' | 'trigger';
  stepName: string | undefined;
}): string | undefined => {
  if (isNil(qadamModel) || isNil(stepName)) {
    return undefined;
  }
  const definition =
    stepKind === 'trigger'
      ? qadamModel.triggers?.[stepName]
      : qadamModel.actions?.[stepName];
  return definition?.description;
};

const findQadamAuthType = (
  qadamModel: QadamMetadataModel | undefined,
): string | undefined => {
  if (isNil(qadamModel) || isNil(qadamModel.auth)) {
    return undefined;
  }
  const auth = Array.isArray(qadamModel.auth)
    ? qadamModel.auth[0]
    : qadamModel.auth;
  return auth?.type;
};

export const stepPropertiesSnapshotUtils = {
  build: toSnapshot,
  findDescription: findStepDescription,
  findAuthType: findQadamAuthType,
};
