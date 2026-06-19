import { DropdownState, PropertyType } from '@aiqadam/qadams-framework';
import { AUTHENTICATION_PROPERTY_NAME, isNil } from '@aiqadam/shared';
import deepEqual from 'deep-equal';
import { t } from 'i18next';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { UseFormReturn, useWatch } from 'react-hook-form';

import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { SearchableSelect } from '@/components/custom/searchable-select';
import { qadamsHooks } from '@/features/qadams';
import { authenticationSession } from '@/lib/authentication-session';

import { MultiSelectQadamProperty } from '../../../components/custom/multi-select-qadam-property';

import { DynamicPropertiesContext } from './dynamic-properties-context';
import { DynamicPropertiesErrorBoundary } from './dynamic-qadam-properties-error-boundary';

const DynamicDropdownQadamPropertyImplementation = React.memo(
  (props: DynamicDropdownProps) => {
    const [flowVersion, readonly] = useBuilderStateContext((state) => [
      state.flowVersion,
      state.readonly,
    ]);

    const isFirstRender = useRef(true);
    const previousValues = useRef<undefined | unknown[]>(undefined);
    const firstDropdownState = useRef<DropdownState<unknown> | undefined>(
      undefined,
    );
    const refreshersWithAuth = [
      ...props.refreshers,
      AUTHENTICATION_PROPERTY_NAME,
    ];
    const [dropdownState, setDropdownState] = useState<DropdownState<unknown>>({
      disabled: false,
      placeholder: t('Select an option'),
      options: [],
    });
    const { propertyLoadingFinished, propertyLoadingStarted } = useContext(
      DynamicPropertiesContext,
    );
    const { mutate, isPending, error } = qadamsHooks.useQadamOptions<
      PropertyType.DROPDOWN | PropertyType.MULTI_SELECT_DROPDOWN
    >({
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
    if (error) {
      throw error;
    }

    const refresherValues = useWatch({
      name: refreshersWithAuth.map((refresher) => {
        if (props.placedInside === 'stepSettings') {
          return `settings.input.${refresher}`;
        }
        return refresher;
      }),
      control: props.form.control,
    });

    const refresh = (term?: string) => {
      const input: Record<string, unknown> = {};
      refreshersWithAuth.forEach((refresher, index) => {
        input[refresher] = refresherValues[index];
      });
      mutate(
        {
          request: {
            projectId: authenticationSession.getProjectId()!,
            qadamName: props.qadamName,
            qadamVersion: props.qadamVersion,
            propertyName: props.propertyName,
            actionOrTriggerName: props.actionOrTriggerName,
            input,
            flowVersionId: flowVersion.id,
            flowId: flowVersion.flowId,
            searchValue: term,
          },
          propertyType: PropertyType.DROPDOWN,
        },
        {
          onSuccess: (response) => {
            if (!firstDropdownState.current) {
              firstDropdownState.current = response.options;
            }
            setDropdownState(response.options);
          },
        },
      );
    };

    useEffect(() => {
      if (
        !isFirstRender.current &&
        !deepEqual(previousValues.current, refresherValues)
      ) {
        props.onChange(null);
      }

      previousValues.current = refresherValues;
      isFirstRender.current = false;
      refresh();
    }, refresherValues);

    const selectOptions = dropdownState.options.map((option) => ({
      label: option.label,
      value: option.value,
    }));
    const isDisabled = dropdownState.disabled || props.disabled;
    return props.multiple ? (
      <MultiSelectQadamProperty
        placeholder={dropdownState.placeholder ?? t('Select an option')}
        options={selectOptions}
        loading={isPending}
        onChange={(value) => props.onChange(value)}
        disabled={isDisabled}
        initialValues={props.value as unknown[]}
        showDeselect={
          props.showDeselect &&
          !isNil(props.value) &&
          Array.isArray(props.value) &&
          props.value.length > 0 &&
          !isDisabled
        }
        showRefresh={!isPending && !readonly}
        onRefresh={refresh}
        refreshOnSearch={props.shouldRefreshOnSearch ? refresh : undefined}
        cachedOptions={firstDropdownState.current?.options ?? []}
      />
    ) : (
      <SearchableSelect
        options={selectOptions}
        disabled={dropdownState.disabled || props.disabled}
        loading={isPending}
        placeholder={dropdownState.placeholder ?? t('Select an option')}
        value={props.value}
        onChange={(value) => props.onChange(value)}
        showDeselect={
          props.showDeselect && !isNil(props.value) && !props.disabled
        }
        onRefresh={refresh}
        showRefresh={!isPending && !readonly}
        refreshOnSearch={props.shouldRefreshOnSearch ? refresh : undefined}
        cachedOptions={firstDropdownState.current?.options ?? []}
      />
    );
  },
);

const DynamicDropdownQadamProperty = React.memo(
  (props: DynamicDropdownProps) => {
    return (
      <DynamicPropertiesErrorBoundary>
        <DynamicDropdownQadamPropertyImplementation {...props} />
      </DynamicPropertiesErrorBoundary>
    );
  },
);
DynamicDropdownQadamProperty.displayName = 'DynamicDropdownQadamProperty';
DynamicDropdownQadamPropertyImplementation.displayName =
  'DynamicDropdownQadamPropertyImplementation';
export { DynamicDropdownQadamProperty };
type DynamicDropdownProps = {
  refreshers: string[];
  propertyName: string;
  value?: unknown;
  multiple?: boolean;
  disabled: boolean;
  onChange: (value: unknown | undefined) => void;
  showDeselect?: boolean;
  shouldRefreshOnSearch?: boolean;
  actionOrTriggerName: string;
  qadamName: string;
  qadamVersion: string;
  form: UseFormReturn;
  placedInside: 'stepSettings' | 'predefinedAgentInputs';
};
