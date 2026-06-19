import {
  QadamMetadataModel,
  QadamMetadataModelSummary,
  PropertyType,
  ExecutePropsResult,
} from '@aiqadam/qadams-framework';
import {
  AddQadamRequestBody,
  FlowActionType,
  flowQadamUtil,
  LocalesEnum,
  QadamOptionRequest,
  PlatformWithoutSensitiveData,
  FlowTriggerType,
  ApFlagId,
  ApEnvironment,
  TelemetryEventName,
} from '@aiqadam/shared';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import semver from 'semver';

import { useTelemetry } from '@/components/providers/telemetry-provider';
import { appConnectionsApi } from '@/features/connections/api/app-connections';
import {
  StepMetadataWithSuggestions,
  CategorizedStepMetadataWithSuggestions,
} from '@/features/qadams/types';
import { flagsHooks } from '@/hooks/flags-hooks';
import { platformHooks } from '@/hooks/platform-hooks';
import { authenticationSession } from '@/lib/authentication-session';

import { qadamsApi } from '../api/qadams-api';
import {
  QadamSelectorTabType,
  useQadamSelectorTabs,
} from '../stores/qadam-selector-tabs-provider';
import { qadamSearchUtils } from '../utils/qadam-search-utils';

import { stepsHooks } from './steps-hooks';

const {
  getPinnedPieces,
  getPopularPieces,
  getAiAndAgentsPieces,
  isUtilityPiece,
  isAppPiece,
  getHighlightedPieces,
  isFlowController,
} = qadamSearchUtils;

type UsePieceModelForStepSettings = {
  name: string;
  version: string | undefined;
  enabled?: boolean;
};

type UsePieceProps = {
  name: string;
  version?: string;
  enabled?: boolean;
};

type UseMultiplePiecesProps = {
  names: string[];
};

type UsePiecesProps = {
  searchQuery?: string;
  includeHidden?: boolean;
  includeTags?: boolean;
  isTableQuery?: boolean;
};
type UsePiecesSearchProps = {
  searchQuery: string;
  enabled?: boolean;
  type: 'action' | 'trigger';
  shouldCaptureEvent: boolean;
};

export const qadamsHooks = {
  useQadam: ({ name, version, enabled = true }: UsePieceProps) => {
    const { i18n } = useTranslation();
    const query = useQuery<QadamMetadataModel, Error>({
      queryKey: ['qadam', name, version],
      queryFn: () =>
        qadamsApi.get({ name, version, locale: i18n.language as LocalesEnum }),
      staleTime: Infinity,
      enabled,
    });
    return {
      qadamModel: query.data,
      isLoading: query.isLoading,
      isSuccess: query.isSuccess,
      refetch: query.refetch,
    };
  },
  useQadamModelForStepSettings: ({
    name,
    version,
    enabled = true,
  }: UsePieceModelForStepSettings) => {
    const exactVersion = version
      ? flowQadamUtil.getExactVersion(version)
      : undefined;
    const qadamQuery = qadamsHooks.useQadam({
      name,
      version: exactVersion,
      enabled,
    });
    return {
      qadamModel: qadamQuery.qadamModel,
      isLoading: qadamQuery.isLoading,
      isSuccess: qadamQuery.isSuccess,
      refetch: qadamQuery.refetch,
    };
  },
  useMultipleQadams: ({ names }: UseMultiplePiecesProps) => {
    const { i18n } = useTranslation();
    return useQueries({
      queries: names.map((name) => ({
        queryKey: ['qadam', name, undefined],
        queryFn: () =>
          qadamsApi.get({
            name,
            version: undefined,
            locale: i18n.language as LocalesEnum,
          }),
        staleTime: Infinity,
      })),
    });
  },
  useQadamSummariesByNames: ({ names }: UseMultiplePiecesProps) => {
    const { qadams, isLoading } = qadamsHooks.useQadams({});
    const summaries = useMemo(() => {
      if (!qadams) return [];
      const byName = new Map(qadams.map((p) => [p.name, p]));
      return names
        .map((name) => byName.get(name))
        .filter((p): p is QadamMetadataModelSummary => !!p);
    }, [qadams, names]);
    return { summaries, isLoading };
  },
  useQadamSummary: ({ name }: { name: string }) => {
    const { qadams, isLoading } = qadamsHooks.useQadams({});
    const summary = useMemo(
      () => qadams?.find((p) => p.name === name),
      [qadams, name],
    );
    return { summary, isLoading };
  },
  useQadams: ({
    searchQuery,
    includeHidden = false,
    includeTags = false,
    isTableQuery = false,
  }: UsePiecesProps) => {
    const { i18n } = useTranslation();
    const query = useQuery<QadamMetadataModelSummary[], Error>({
      queryKey: [
        isTableQuery ? 'qadams-table' : 'qadams',
        searchQuery,
        includeHidden,
      ],
      queryFn: () =>
        qadamsApi.list({
          projectId: authenticationSession.getProjectId()!,
          searchQuery,
          includeHidden,
          includeTags,
          locale: i18n.language as LocalesEnum,
        }),
      staleTime: searchQuery ? 0 : Infinity,
      meta: isTableQuery
        ? { showErrorDialog: true, loadSubsetOptions: {} }
        : undefined,
    });
    return {
      qadams: query.data,
      isLoading: query.isLoading,
      refetch: query.refetch,
    };
  },
  useQadamsSearch: (
    props: UsePiecesSearchProps,
  ): {
    isLoading: boolean;
    data: CategorizedStepMetadataWithSuggestions[];
  } => {
    const { selectedTab } = useQadamSelectorTabs();
    const { capture } = useTelemetry();
    const { data: environment } = flagsHooks.useFlag<ApEnvironment>(
      ApFlagId.ENVIRONMENT,
    );
    const { metadata, isLoading: isLoadingPieces } =
      stepsHooks.useAllStepsMetadata(props);
    const { platform } = platformHooks.useCurrentPlatform();
    if (!metadata || isLoadingPieces) {
      return {
        isLoading: true,
        data: [],
      };
    }
    const piecesMetadataWithoutEmptySuggestions =
      filterOutPiecesWithNoSuggestions(metadata);

    const pinnedPieces = getPinnedPieces(
      piecesMetadataWithoutEmptySuggestions,
      platform.pinnedQadams ?? [],
    );

    const popularPieces = getPopularPieces(
      piecesMetadataWithoutEmptySuggestions,
      platform.pinnedQadams ?? [],
    );

    const flowControllerPieces =
      piecesMetadataWithoutEmptySuggestions.filter(isFlowController);

    const utilityPieces =
      piecesMetadataWithoutEmptySuggestions.filter(isUtilityPiece);

    const qadamMetadataWithoutPopularOrPinnedPieces =
      piecesMetadataWithoutEmptySuggestions.filter(
        (p) => !popularPieces.includes(p) && !pinnedPieces.includes(p),
      );

    const appPieces =
      qadamMetadataWithoutPopularOrPinnedPieces.filter(isAppPiece);

    const utilitiesCategory = {
      title: t('Utility'),
      metadata: utilityPieces,
    };
    const flowControllerCategory = {
      title: t('Flow Controller'),
      metadata: flowControllerPieces,
    };
    const appsCategory = {
      title: t('Apps'),
      metadata: appPieces,
    };
    const popularCategory = {
      title: t('Popular'),
      metadata: popularPieces,
    };
    const allCategory = {
      title: t('All'),
      metadata: piecesMetadataWithoutEmptySuggestions,
    };

    switch (selectedTab) {
      case QadamSelectorTabType.EXPLORE:
        return {
          isLoading: false,
          data: getExploreTabContent(
            piecesMetadataWithoutEmptySuggestions,
            platform,
            props.type,
            environment,
          ),
        };
      case QadamSelectorTabType.UTILITY:
        return {
          isLoading: false,
          data: [utilitiesCategory, flowControllerCategory],
        };
      case QadamSelectorTabType.AI_AND_AGENTS:
        return {
          isLoading: false,
          data: getAiAndAgentsPieces(piecesMetadataWithoutEmptySuggestions),
        };
      case QadamSelectorTabType.APPROVALS:
        return {
          isLoading: false,
          data: [],
        };
      case QadamSelectorTabType.APPS: {
        const popularAppsCategory = {
          ...popularCategory,
          metadata: popularCategory.metadata.filter(isAppPiece),
        };
        const result = {
          isLoading: false,
          data: [popularAppsCategory, appsCategory],
        };
        if (pinnedPieces.length > 0) {
          result.data.unshift({
            title: t('Highlights'),
            metadata: pinnedPieces,
          });
        }
        return result;
      }

      case QadamSelectorTabType.NONE: {
        if (props.shouldCaptureEvent && props.searchQuery.length > 3) {
          capture({
            name: TelemetryEventName.PIECE_SELECTOR_SEARCH,
            payload: {
              search: props.searchQuery,
              isTrigger: props.type === 'trigger',
              selectedActionOrTriggerName: null,
            },
          });
        }
        return {
          isLoading: false,
          data: allCategory.metadata.length > 0 ? [allCategory] : [],
        };
      }
    }
  },
  useQadamOptions: <
    T extends
      | PropertyType.DYNAMIC
      | PropertyType.DROPDOWN
      | PropertyType.MULTI_SELECT_DROPDOWN,
  >({
    onSuccess,
    onError,
    onMutate,
  }: {
    onSuccess: (data: ExecutePropsResult<T>) => void;
    onError: (error: Error) => void;
    onMutate: () => void;
  }) => {
    return useMutation<
      ExecutePropsResult<T>,
      Error,
      { request: QadamOptionRequest; propertyType: T }
    >({
      mutationFn: async ({ request, propertyType }) => {
        onMutate();
        return qadamsApi.options(request, propertyType);
      },
      onSuccess,
      onError,
      retry: 1,
      retryDelay: 1000,
    });
  },
  useQadamVersions: (qadamName: string) => {
    const { data: release } = flagsHooks.useFlag<string>(
      ApFlagId.CURRENT_VERSION,
    );
    const query = useQuery({
      queryKey: ['qadams-registry', release],
      queryFn: () => qadamsApi.registry(release!),
      staleTime: Infinity,
      enabled: !!qadamName && !!release,
      select: (registry) =>
        registry
          .filter((entry) => entry.name === qadamName)
          .map((entry) => ({ version: entry.version }))
          .sort((a, b) => semver.rcompare(a.version, b.version)),
    });
    return {
      qadamVersions: query.data,
      isLoading: query.isLoading,
    };
  },
  useQadamForEmbeddingConnection: ({
    qadamName,
    connectionExternalId,
  }: {
    qadamName: string;
    connectionExternalId: string;
  }) => {
    return useQuery<QadamMetadataModel, Error>({
      queryKey: ['qadam', qadamName, connectionExternalId],
      queryFn: async () => {
        const appConnection = (
          await appConnectionsApi.list({
            qadamName,
            limit: 1,
            projectId: authenticationSession.getProjectId()!,
          })
        ).data.find(
          (connection) => connection.externalId === connectionExternalId,
        );
        if (!appConnection) {
          return qadamsApi.get({ name: qadamName });
        }
        return qadamsApi.get({
          name: appConnection.qadamName,
          version: appConnection.qadamVersion,
        });
      },
      staleTime: Infinity,
    });
  },
};

export const qadamsMutations = {
  useInstallQadam: ({
    onSuccess,
    onError,
  }: {
    onSuccess: () => void;
    onError: (error: unknown) => void;
  }) => {
    return useMutation({
      mutationFn: (data: AddQadamRequestBody) => qadamsApi.install(data),
      onSuccess,
      onError,
    });
  },
};

const filterOutPiecesWithNoSuggestions = (
  stepsMetadata: StepMetadataWithSuggestions[],
) => {
  return stepsMetadata.filter((metadata) => {
    const isActionWithSuggestions =
      metadata.type === FlowActionType.PIECE &&
      metadata.suggestedActions &&
      metadata.suggestedActions.length > 0;

    const isTriggerWithSuggestions =
      metadata.type === FlowTriggerType.PIECE &&
      metadata.suggestedTriggers &&
      metadata.suggestedTriggers.length > 0;

    const isNotQadamType =
      metadata.type !== FlowActionType.PIECE &&
      metadata.type !== FlowTriggerType.PIECE;
    return (
      isActionWithSuggestions || isTriggerWithSuggestions || isNotQadamType
    );
  });
};

const getExploreTabContent = (
  queryResult: StepMetadataWithSuggestions[],
  platform: PlatformWithoutSensitiveData,
  type: 'action' | 'trigger',
  environment: ApEnvironment | null,
) => {
  const popularCategory: CategorizedStepMetadataWithSuggestions = {
    title: t('Popular'),
    metadata: environment === ApEnvironment.DEVELOPMENT ? queryResult : [],
  };
  if (environment === ApEnvironment.DEVELOPMENT) {
    return [popularCategory];
  }
  const pinnedPieces = getPinnedPieces(
    queryResult,
    platform.pinnedQadams ?? [],
  );
  const popularPieces = getPopularPieces(
    queryResult,
    platform.pinnedQadams ?? [],
  );

  if (popularPieces.length > 0) {
    popularCategory.metadata = [...popularCategory.metadata, ...popularPieces];
  }

  const hightlightedPiecesCategory: CategorizedStepMetadataWithSuggestions = {
    title: t('Highlights'),
    metadata: [],
  };
  const highlightedPieces = getHighlightedPieces(queryResult, type);
  const codePiece = queryResult.find(
    (piece) => piece.type === FlowActionType.CODE,
  );
  const branchPiece = queryResult.find(
    (piece) => piece.type === FlowActionType.ROUTER,
  );
  const loopPiece = queryResult.find(
    (piece) => piece.type === FlowActionType.LOOP_ON_ITEMS,
  );

  if (highlightedPieces.length > 0) {
    hightlightedPiecesCategory.metadata.push(...highlightedPieces);
  }

  if (branchPiece) {
    hightlightedPiecesCategory.metadata.splice(0, 0, branchPiece);
  }

  if (codePiece) {
    hightlightedPiecesCategory.metadata.splice(3, 0, codePiece);
  }
  if (loopPiece) {
    hightlightedPiecesCategory.metadata.splice(5, 0, loopPiece);
  }
  if (pinnedPieces.length > 0) {
    hightlightedPiecesCategory.metadata = [
      ...pinnedPieces,
      ...hightlightedPiecesCategory.metadata,
    ];
  }

  return [popularCategory, hightlightedPiecesCategory];
};
