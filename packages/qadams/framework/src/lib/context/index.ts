import {
  AgentQadamTool,
  AppConnectionType,
  AppConnectionValue,
  ExecutionType,
  FlowRunId,
  PopulatedFlow,
  ProjectId,
  RespondResponse,
  ResumePayload,
  SeekPage,
  TriggerPayload,
  TriggerStrategy,
} from '@aiqadam/shared';
import { LanguageModel, Tool } from 'ai'

import {
  BasicAuthProperty,
  CustomAuthProperty,
  InputPropertyMap,
  OAuth2Property,
  SecretTextProperty,
  StaticPropsValue,
} from '../property';
import { QadamAuthProperty } from '../property/authentication';
import { DelayPauseMetadata, PauseMetadata, WebhookPauseMetadata } from '@aiqadam/shared';

export type BaseContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  Props extends InputPropertyMap
> = {
  flows: FlowsContext;
  step: StepContext;
    auth: AppConnectionValueForAuthProperty<QadamAuth>;
  propsValue: StaticPropsValue<Props>;
  store: Store;
  project: {
    id: ProjectId;
    externalId: () => Promise<string | undefined>;
  };
  connections: ConnectionsManager;
};


type ExtractCustomAuthProps<T> = T extends CustomAuthProperty<infer Props> ? Props : never;

type ExtractOAuth2Props<T> = T extends OAuth2Property<infer Props> ? Props : never;


export type AppConnectionValueForAuthProperty<T extends QadamAuthProperty | QadamAuthProperty[] | undefined> = 
  T extends QadamAuthProperty[] ? AppConnectionValueForSingleAuthProperty<T[number]> :
  T extends QadamAuthProperty ? AppConnectionValueForSingleAuthProperty<T> :
  T extends undefined ? undefined : never;

type AppConnectionValueForSingleAuthProperty<T extends QadamAuthProperty | undefined> = 
  T extends SecretTextProperty<boolean> ? AppConnectionValue<AppConnectionType.SECRET_TEXT> :
  T extends BasicAuthProperty ? AppConnectionValue<AppConnectionType.BASIC_AUTH> :
  T extends CustomAuthProperty<any> ? AppConnectionValue<AppConnectionType.CUSTOM_AUTH, StaticPropsValue<ExtractCustomAuthProps<T>>> :
  T extends OAuth2Property<any> ? AppConnectionValue<AppConnectionType.OAUTH2, StaticPropsValue<ExtractOAuth2Props<T>>> :
  T extends undefined ? undefined : never;
type AppWebhookTriggerHookContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  TriggerProps extends InputPropertyMap
> = BaseContext<QadamAuth, TriggerProps> & {
  webhookUrl: string;
  payload: TriggerPayload;
  app: {
    createListeners({
      events,
      identifierValue,
    }: {
      events: string[];
      identifierValue: string;
    }): void;
  };
};

type PollingTriggerHookContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  TriggerProps extends InputPropertyMap
> = BaseContext<QadamAuth, TriggerProps> & {
  setSchedule(schedule: { cronExpression: string; timezone?: string }): void;
};

type WebhookTriggerHookContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  TriggerProps extends InputPropertyMap,
> = BaseContext<QadamAuth, TriggerProps> & {
  webhookUrl: string;
  payload: TriggerPayload;
  server: ServerContext;
};
export type TriggerHookContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  TriggerProps extends InputPropertyMap,
  S extends TriggerStrategy,
> = S extends TriggerStrategy.APP_WEBHOOK
  ? AppWebhookTriggerHookContext<QadamAuth, TriggerProps>
  : S extends TriggerStrategy.POLLING
  ? PollingTriggerHookContext<QadamAuth, TriggerProps>
  : S extends TriggerStrategy.WEBHOOK
  ? WebhookTriggerHookContext<QadamAuth, TriggerProps> & {
    server: ServerContext;
  }
  : never;

export type TestOrRunHookContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  TriggerProps extends InputPropertyMap,
  S extends TriggerStrategy
> = TriggerHookContext<QadamAuth, TriggerProps, S> & {
  files: FilesService;
};

export type StopHookParams = {
  response: RespondResponse;
};

export type RespondHookParams = {
  response: RespondResponse;
};

export type StopHook = (params?: StopHookParams) => void;

export type RespondHook = (params?: RespondHookParams) => void;

/** @deprecated Since 2026-04-12. Use {@link CreateWaitpointHook} and {@link WaitForWaitpointHook} instead. */
export type PauseHookParams = {
  pauseMetadata: PauseMetadata;
};

/** @deprecated Since 2026-04-12. Use {@link CreateWaitpointHook} and {@link WaitForWaitpointHook} instead. */
export type PauseHook = (params: {
  pauseMetadata: Omit<DelayPauseMetadata, 'requestIdToReply'> | Omit<WebhookPauseMetadata, 'requestId' | 'requestIdToReply'>
}) => void;

export type FlowsContext = {
  list(params?: ListFlowsContextParams): Promise<SeekPage<PopulatedFlow>>
  current: {
    id: string;
    version: {
      id: string;
    };
  };
}

export type StepContext = {
  name: string;
}

export type ListFlowsContextParams = {
  externalIds?: string[]
}


export type PropertyContext = {
  server: ServerContext;
  project: {
    id: ProjectId;
    externalId: () => Promise<string | undefined>;
  };
  searchValue?: string;
  flows: FlowsContext;
  connections: ConnectionsManager;
};

export type ServerContext = {
  apiUrl: string;
  publicUrl: string;
  token: string;
};

export type CreateWaitpointParams = {
  type: 'DELAY' | 'WEBHOOK';
  version?: 'V0' | 'V1';
  resumeDateTime?: string;
  responseToSend?: RespondResponse;
};

export type CreateWaitpointResult = {
  id: string;
  resumeUrl: string;
  buildResumeUrl: (params: { queryParams: Record<string, string>, sync?: boolean }) => string;
};

export type CreateWaitpointHook = (params: CreateWaitpointParams) => Promise<CreateWaitpointResult>;
export type WaitForWaitpointHook = (waitpointId: string) => void;

export type RunContext = {
  id: FlowRunId;
  stop: StopHook;
  /** @deprecated Use createWaitpoint + waitForWaitpoint instead */
  pause?: PauseHook;
  respond: RespondHook;
  createWaitpoint: CreateWaitpointHook;
  waitForWaitpoint: WaitForWaitpointHook;
}

export type OnStartContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  TriggerProps extends InputPropertyMap
> = Omit<BaseContext<QadamAuth, TriggerProps>, 'flows'> & {
  run: Pick<RunContext, 'id'>;
  payload: unknown;
}


export type OutputContext = {
  update: (params: {
    data: {
      [key: string]: unknown;
    };
  }) => Promise<void>;
}

type BaseActionContext<
  ET extends ExecutionType,
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined,
  ActionProps extends InputPropertyMap
> = BaseContext<QadamAuth, ActionProps> & {
  executionType: ET;
  tags: TagsManager;
  server: ServerContext;
  files: FilesService;
  output: OutputContext;
  agent: AgentContext;
  run: RunContext;
  /** @deprecated Use waitpoint.buildResumeUrl() from createWaitpoint result instead */
  generateResumeUrl?: (params: {
    queryParams: Record<string, string>,
    sync?: boolean
  }) => string;
};

type BeginExecutionActionContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = undefined,
  ActionProps extends InputPropertyMap = InputPropertyMap
> = BaseActionContext<ExecutionType.BEGIN, QadamAuth, ActionProps>;

type ResumeExecutionActionContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = undefined,
  ActionProps extends InputPropertyMap = InputPropertyMap
> = BaseActionContext<ExecutionType.RESUME, QadamAuth, ActionProps> & {
  resumePayload: ResumePayload;
};

export type ActionContext<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = undefined,
  ActionProps extends InputPropertyMap = InputPropertyMap
> =
  | BeginExecutionActionContext<QadamAuth, ActionProps>
  | ResumeExecutionActionContext<QadamAuth, ActionProps>;




export type ConstructToolParams = {
  tools: AgentQadamTool[]
  model: LanguageModel,
}

export interface AgentContext {
  tools: (params: ConstructToolParams) => Promise<Record<string, Tool>>;
}

export interface FilesService {
  write({
    fileName,
    data,
  }: {
    fileName: string;
    data: Buffer;
  }): Promise<string>;
}

export interface ConnectionsManager {
  get(
    key: string
  ): Promise<AppConnectionValue | Record<string, unknown> | string | null>;
}

export interface TagsManager {
  add(params: { name: string }): Promise<void>;
}

export interface Store {
  put<T>(key: string, value: T, scope?: StoreScope): Promise<T>;
  get<T>(key: string, scope?: StoreScope): Promise<T | null>;
  delete(key: string, scope?: StoreScope): Promise<void>;
}

export enum StoreScope {
  // Collection were deprecated in favor of project
  PROJECT = 'COLLECTION',
  FLOW = 'FLOW',
}