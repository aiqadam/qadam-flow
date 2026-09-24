import { createAction, Property } from '@aiqadam/qadams-framework';
import { httpClient, HttpMethod } from '@aiqadam/qadams-common';
import {
  ExecutionType,
  FAIL_PARENT_ON_FAILURE_HEADER,
  FlowStatus,
  isNil,
  JOIN_WAITPOINT_MAX_SLOTS,
  JoinFailurePolicy,
  JoinResult,
  PARENT_RUN_ID_HEADER,
} from '@aiqadam/shared';
import { callableFlowDropdown, CallableFlowRequest, CallableFlowResponse, findFlowByExternalIdOrThrow } from '../common';

// Fan-out with fan-in (#374): one queue-mode child run per item, and one pause until they have
// all answered — or the failure policy decides earlier. Each child runs as its own job, with its
// own timeout, and may pause itself; the parent resumes once, with every answer in item order.
export const callFlowForEach = createAction({
  name: 'callFlowForEach',
  pauses: true,
  displayName: 'Call Flow for Each Item',
  description: 'Call a flow that has a "Callable Flow" trigger once per item, in parallel, and wait until they have all answered',
  props: {
    flow: callableFlowDropdown(),
    items: Property.Json({
      displayName: 'Items',
      description: "A list with one payload per call, e.g. {{step_1['output'].rows}}. At most 500 items.",
      required: true,
    }),
    failurePolicy: Property.StaticDropdown({
      displayName: 'When a call fails',
      description: 'Wait for every call and report each result, stop waiting at the first failure, or succeed as soon as enough calls have succeeded.',
      required: true,
      defaultValue: JoinFailurePolicy.enum.ALL_SETTLED,
      options: {
        disabled: false,
        options: [
          { label: 'Wait for all and report each result', value: JoinFailurePolicy.enum.ALL_SETTLED },
          { label: 'Fail at the first failure', value: JoinFailurePolicy.enum.FAIL_FAST },
          { label: 'Succeed once a quorum succeeded', value: JoinFailurePolicy.enum.QUORUM },
        ],
      },
    }),
    quorum: Property.Number({
      displayName: 'Quorum',
      description: 'With "Succeed once a quorum succeeded": how many calls must succeed.',
      required: false,
    }),
    joinTimeoutSeconds: Property.Number({
      displayName: 'Stop waiting after (seconds)',
      description: 'Continue with the answers that arrived by then; the rest are reported as timed out. Leave empty to wait for every call.',
      required: false,
    }),
  },
  async run(context) {
    if (context.executionType === ExecutionType.RESUME) {
      return readJoinResult(context.resumePayload.body);
    }
    const items = context.propsValue.items;
    if (!Array.isArray(items)) {
      throw new Error(JSON.stringify({ message: 'Items must be a list, with one payload per call.' }));
    }
    if (items.length > JOIN_WAITPOINT_MAX_SLOTS) {
      throw new Error(JSON.stringify({ message: `At most ${JOIN_WAITPOINT_MAX_SLOTS} items can be called at once; got ${items.length}. Split the list, e.g. with a Loop.` }));
    }
    const failurePolicy = JoinFailurePolicy.parse(context.propsValue.failurePolicy);
    const quorum = context.propsValue.quorum ?? undefined;
    if (failurePolicy === JoinFailurePolicy.enum.QUORUM && (isNil(quorum) || !Number.isInteger(quorum) || quorum < 1 || quorum > items.length)) {
      throw new Error(JSON.stringify({ message: `Quorum must be a whole number from 1 to the number of items (${items.length}).` }));
    }
    const timeoutSeconds = context.propsValue.joinTimeoutSeconds ?? undefined;
    if (!isNil(timeoutSeconds) && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)) {
      throw new Error(JSON.stringify({ message: 'Stop waiting after must be a whole number of seconds, at least 1.' }));
    }
    if (items.length === 0) {
      const empty: JoinResult = { results: [], succeeded: 0, failed: 0, timedOut: 0 };
      return empty;
    }

    const flow = await findFlowByExternalIdOrThrow({
      flowsContext: context.flows,
      externalId: context.propsValue.flow?.externalId,
    });
    if (flow.status !== FlowStatus.ENABLED) {
      throw new Error(JSON.stringify({
        message: 'The selected subflow is disabled. Enable it before calling it from a parent flow.',
        externalId: context.propsValue.flow?.externalId,
        flowName: flow.version.displayName,
      }));
    }

    const waitpoint = await context.run.createWaitpoint({
      type: 'WEBHOOK',
      // Answered exclusively by the children's own Return Response steps posting back into this
      // deployment, so the slot URLs are built from its internal address.
      internal: true,
      join: { slots: items.length, failurePolicy, quorum, timeoutSeconds },
    });
    const slotUrls = waitpoint.slotResumeUrls ?? [];
    if (slotUrls.length !== items.length) {
      throw new Error(JSON.stringify({ message: 'The server did not return one callback per item.' }));
    }
    context.run.waitForWaitpoint(waitpoint.id);

    await forEachWithConcurrency({
      count: items.length,
      concurrency: DISPATCH_CONCURRENCY,
      task: async (index) => {
        const dispatched = await dispatchChild({
          url: `${context.server.apiUrl}v1/webhooks/${flow.id}`,
          parentRunId: context.run.id,
          payload: items[index],
          callbackUrl: slotUrls[index],
        });
        if (!dispatched.ok) {
          // A child that never started still owes its slot an answer, or the join waits forever.
          await answerSlot({ url: slotUrls[index], answer: { status: 'error', data: { message: dispatched.message } } });
        }
      },
    });
    return { dispatched: items.length };
  },
});

async function dispatchChild({ url, parentRunId, payload, callbackUrl }: DispatchChildParams): Promise<{ ok: true } | { ok: false, message: string }> {
  try {
    await httpClient.sendRequest<CallableFlowRequest>({
      method: HttpMethod.POST,
      url,
      headers: {
        'Content-Type': 'application/json',
        [PARENT_RUN_ID_HEADER]: parentRunId,
        [FAIL_PARENT_ON_FAILURE_HEADER]: 'true',
      },
      body: {
        data: payload,
        callbackUrl,
      },
    });
    return { ok: true };
  }
  catch (error) {
    return { ok: false, message: `The subflow could not be started: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function answerSlot({ url, answer }: { url: string, answer: CallableFlowResponse }): Promise<void> {
  await httpClient.sendRequest<CallableFlowResponse>({
    method: HttpMethod.POST,
    url,
    body: answer,
    retries: 3,
  });
}

async function forEachWithConcurrency({ count, concurrency, task }: ForEachWithConcurrencyParams): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next;
      next += 1;
      await task(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
}

// The server decided the policy; an `error` status means it was not met.
function readJoinResult(body: unknown): JoinResult {
  const envelope = typeof body === 'object' && body !== null && 'status' in body && 'data' in body ? body : undefined;
  const parsed = JoinResult.safeParse(envelope?.data);
  if (isNil(envelope) || !parsed.success) {
    throw new Error(JSON.stringify({ message: 'The subflows answered in an unexpected shape.' }));
  }
  const data = parsed.data;
  if (envelope.status === 'error') {
    throw new Error(JSON.stringify({
      message: `The subflows did not meet the failure policy: ${data.succeeded} succeeded, ${data.failed} failed, ${data.timedOut} timed out.`,
      ...data,
    }));
  }
  return data;
}

const DISPATCH_CONCURRENCY = 10;

type DispatchChildParams = {
  url: string;
  parentRunId: string;
  payload: unknown;
  callbackUrl: string;
};

type ForEachWithConcurrencyParams = {
  count: number;
  concurrency: number;
  task: (index: number) => Promise<void>;
};
