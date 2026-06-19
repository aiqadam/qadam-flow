import { QadamPropertyMap, PropertyType } from '@aiqadam/qadams-framework';
import {
  AUTHENTICATION_PROPERTY_NAME,
  isNil,
  PropertySettings,
} from '@aiqadam/shared';
import deepEqual from 'deep-equal';
import React, { useState, useRef, useContext } from 'react';
import { useFormContext, UseFormReturn, useWatch } from 'react-hook-form';
import { useDeepCompareEffectNoCheck } from 'use-deep-compare-effect';

import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { SkeletonList } from '@/components/ui/skeleton';
import { qadamsHooks, formUtils } from '@/features/qadams';
import { authenticationSession } from '@/lib/authentication-session';

import { DynamicPropertiesContext } from './dynamic-properties-context';
import { DynamicPropertiesErrorBoundary } from './dynamic-qadam-properties-error-boundary';
import { GenericPropertiesForm } from './generic-properties-form';

const removeOptionsFromDropdownPropertiesSchema = (
  schema: QadamPropertyMap,
): QadamPropertyMap => {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (
        value.type === PropertyType.STATIC_DROPDOWN ||
        value.type === PropertyType.STATIC_MULTI_SELECT_DROPDOWN
      ) {
        return [key, { ...value, options: { disabled: false, options: [] } }];
      }
      return [key, value];
    }),
  ) as QadamPropertyMap;
};

const DynamicPropertiesImplementation = React.memo(
  (props: DynamicPropertiesProps) => {
    const [flowVersion, readonly] = useBuilderStateContext((state) => [
      state.flowVersion,
      state.readonly,
    ]);
    const form = useFormContext();
    const watchConfig: Record<string, unknown> = {
      name:
        props.placedInside === 'stepSettings' ? 'settings.input' : undefined,
    };
    const allInputsValues = useWatch(watchConfig);
    const refreshersPropertiesNames = [
      ...props.refreshers,
      AUTHENTICATION_PROPERTY_NAME,
    ];
    const refresherValues = refreshersPropertiesNames.reduce<
      Record<string, unknown>
    >((acc, refresher) => {
      acc[refresher] = allInputsValues[refresher];
      return acc;
    }, {});
    const previousRefresherValues =
      useRef<Record<string, unknown>>(refresherValues);
    const { propertyLoadingFinished, propertyLoadingStarted } = useContext(
      DynamicPropertiesContext,
    );
    const [propertyMap, setPropertyMap] = useState<
      QadamPropertyMap | undefined
    >(undefined);
    const propertyPrefix =
      props.placedInside === 'stepSettings' ? 'settings.input' : '';
    const { mutate, isPending } =
      qadamsHooks.useQadamOptions<PropertyType.DYNAMIC>({
        onMutate: () => {
          propertyLoadingStarted(props.propertyName);
        },
        onError: (error) => {
          console.error(error);
          propertyLoadingFinished(props.propertyName);
        },
        onSuccess: () => {
          propertyLoadingFinished(props.propertyName);
        },
      });

    const clearPropertyValue = () => {
      // the field state won't be cleared if you only unset the parent prop value
      if (propertyMap) {
        Object.keys(propertyMap).forEach((childPropName) => {
          form.setValue(
            prependPrefixToPropertyName({
              propertyName: `${props.propertyName}.${childPropName}`,
              prefix: propertyPrefix,
            }),
            null,
            {
              //never validate for each prop, it can be a long list of props and cause the browser to freeze
              shouldValidate: false,
            },
          );
        });
      }
      form.setValue(
        prependPrefixToPropertyName({
          propertyName: props.propertyName,
          prefix: propertyPrefix,
        }),
        null,
        {
          shouldValidate: true,
        },
      );
    };
    useDeepCompareEffectNoCheck(() => {
      if (!deepEqual(previousRefresherValues.current, refresherValues)) {
        clearPropertyValue();
      }
      previousRefresherValues.current = refresherValues;
      mutate(
        {
          request: {
            projectId: authenticationSession.getProjectId()!,
            qadamName: props.qadamName,
            qadamVersion: props.qadamVersion,
            propertyName: props.propertyName,
            actionOrTriggerName: props.actionOrTriggerName,
            input: refresherValues,
            flowVersionId: flowVersion.id,
            flowId: flowVersion.flowId,
          },
          propertyType: PropertyType.DYNAMIC,
        },
        {
          onSuccess: (response) => {
            const currentValue = form.getValues(
              prependPrefixToPropertyName({
                propertyName: props.propertyName,
                prefix: propertyPrefix,
              }),
            );
            const defaultValue = formUtils.getDefaultValueForProperties({
              props: response.options,
              existingInput: currentValue ?? {},
              propertySettings: props.propertySettings ?? {},
            });
            setPropertyMap(response.options);
            const schemaWithoutDropdownOptions =
              removeOptionsFromDropdownPropertiesSchema(response.options);
            props.updateFormSchema?.(
              prependPrefixToPropertyName({
                propertyName: props.propertyName,
                prefix: propertyPrefix,
              }),
              schemaWithoutDropdownOptions,
            );

            if (!readonly && props.updatePropertySettingsSchema) {
              props.updatePropertySettingsSchema(
                schemaWithoutDropdownOptions,
                props.propertyName,
                form,
              );
            }
            form.setValue(
              prependPrefixToPropertyName({
                propertyName: props.propertyName,
                prefix: propertyPrefix,
              }),
              defaultValue,
              {
                shouldValidate: true,
                shouldDirty: true,
              },
            );
          },
        },
      );
    }, [refresherValues]);

    return (
      <>
        {isPending && (
          <SkeletonList numberOfItems={3} className="h-7"></SkeletonList>
        )}
        {!isPending && propertyMap && (
          <GenericPropertiesForm
            prefixValue={prependPrefixToPropertyName({
              propertyName: props.propertyName,
              prefix: propertyPrefix,
            })}
            props={propertyMap}
            useMentionTextInput={!isNil(props.propertySettings)}
            disabled={props.disabled}
            propertySettings={props.propertySettings}
            dynamicPropsInfo={null}
            onValueChange={() => {
              form.trigger();
            }}
          ></GenericPropertiesForm>
        )}
      </>
    );
  },
);

const DynamicProperties = React.memo((props: DynamicPropertiesProps) => {
  return (
    <DynamicPropertiesErrorBoundary>
      <DynamicPropertiesImplementation {...props} />
    </DynamicPropertiesErrorBoundary>
  );
});
DynamicPropertiesImplementation.displayName = 'DynamicPropertiesImplementation';
DynamicProperties.displayName = 'DynamicProperties';
export { DynamicProperties };

const prependPrefixToPropertyName = ({
  propertyName,
  prefix,
}: {
  propertyName: string;
  prefix: string;
}) => {
  return prefix.length === 0 ? propertyName : `${prefix}.${propertyName}`;
};

type DynamicPropertiesProps = {
  refreshers: string[];
  propertyName: string;
  qadamName: string;
  qadamVersion: string;
  actionOrTriggerName: string;
  disabled: boolean;
  placedInside: 'stepSettings' | 'predefinedAgentInputs';
  updateFormSchema:
    | ((key: string, newFieldSchema: QadamPropertyMap) => void)
    | null;
  propertySettings: Record<string, PropertySettings> | null;
  updatePropertySettingsSchema:
    | ((
        schema: QadamPropertyMap,
        propertyName: string,
        form: UseFormReturn,
      ) => void)
    | null;
};
