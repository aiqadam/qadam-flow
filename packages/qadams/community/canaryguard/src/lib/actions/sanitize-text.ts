import { HttpMethod, httpClient } from '@aiqadam/qadams-common';
import { createAction, Property } from '@aiqadam/qadams-framework';
import { sanitizeContentLocal } from '../local-sanitizer';

const DEFAULT_BASE_URL = 'https://canaryguard-402.onrender.com';

type CanaryGuardApiResponse = {
  status?: string;
  risk_score?: number;
  injection_detected?: boolean;
  threats_neutralized?: string[];
  sanitized_content?: string | null;
  safety_receipt?: string;
};

function resolveEndpointUrl(baseUrlInput: string | undefined, usePaid: boolean): string {
  const rawBase = (baseUrlInput ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const parsed = new URL(rawBase);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Service Base URL must use http or https protocol.');
  }
  const normalizedBase = rawBase.replace(/\/+$/, '');
  return `${normalizedBase}${usePaid ? '/v1/sanitize' : '/v1/sanitize/preview'}`;
}

export const sanitizeTextAction = createAction({
  name: 'sanitize_text',
  displayName: 'Sanitize Text',
  description:
    'Scan and sanitize untrusted text, emails, or web content for prompt-injection and wallet-drain instructions.',
  audience: 'both',
  aiMetadata: {
    description:
      'Runs deterministic prompt-injection detection and sanitization against text before an AI agent consumes it. Defaults to the free evaluation endpoint (/v1/sanitize/preview) or uses paid x402 (/v1/sanitize) when an x402 PAYMENT-SIGNATURE header is supplied. Read-only and idempotent for the same text and strict_mode.',
    idempotent: true,
  },
  props: {
    content: Property.LongText({
      displayName: 'Untrusted Content',
      description:
        'Paste external text, webpage extracts, email bodies, or tool outputs to inspect and sanitize before sending them to an LLM.',
      required: true,
    }),
    strict_mode: Property.Checkbox({
      displayName: 'Strict Mode',
      description:
        'When enabled, detected instruction overrides return an empty sanitized string instead of partial scrubbed output.',
      required: false,
      defaultValue: true,
    }),
    payment_signature: Property.ShortText({
      displayName: 'x402 PAYMENT-SIGNATURE (Optional)',
      description:
        'Optional Base64 x402 v2 PAYMENT-SIGNATURE header to call the paid /v1/sanitize endpoint ($0.010 USDC on Base). Leave blank to evaluate via free /v1/sanitize/preview.',
      required: false,
    }),
    base_url: Property.ShortText({
      displayName: 'Service Base URL (Optional)',
      description:
        'Override the CanaryGuard API URL (defaults to https://canaryguard-402.onrender.com).',
      required: false,
      defaultValue: DEFAULT_BASE_URL,
    }),
    execution_mode: Property.StaticDropdown({
      displayName: 'Execution Mode',
      description:
        'Run deterministic sanitization in-process (<2ms, free, zero network) or via CanaryGuard Cloud API.',
      required: false,
      defaultValue: 'local_fast',
      options: {
        options: [
          {
            label: 'In-Process Sub-10ms Engine (~1ms, Free)',
            value: 'local_fast',
          },
          {
            label: 'CanaryGuard Cloud API (HTTPS)',
            value: 'cloud_api',
          },
        ],
      },
    }),
  },
  async run(context) {
    const paymentSignature = context.propsValue.payment_signature?.trim();
    const usePaid = Boolean(paymentSignature);
    const executionMode =
      usePaid || context.propsValue.execution_mode === 'cloud_api'
        ? 'cloud_api'
        : 'local_fast';

    if (executionMode === 'local_fast') {
      const local = sanitizeContentLocal(
        context.propsValue.content,
        context.propsValue.strict_mode ?? true
      );
      return {
        status: local.status,
        injection_detected: local.injection_detected,
        risk_score: local.risk_score,
        sanitized_content: local.sanitized_content,
        threats_neutralized: local.threats_neutralized.join(', '),
        threat_count: local.threats_neutralized.length,
        safety_receipt: local.safety_receipt,
        latency_ms: local.latency_ms,
        execution_mode: 'local_fast',
        payment_mode: 'local_free',
        upgrade_hint:
          'Executed in-process (<10ms, zero network). Provide a Base64 x402 v2 PAYMENT-SIGNATURE header or select Cloud API mode for hosted /v1/sanitize telemetry ($0.010 USDC/call on Base).',
      };
    }

    const endpoint = resolveEndpointUrl(context.propsValue.base_url, usePaid);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (paymentSignature) {
      headers['PAYMENT-SIGNATURE'] = paymentSignature;
      headers['X-PAYMENT'] = paymentSignature;
    }

    const t0 =
      typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now();
    const response = await httpClient.sendRequest<CanaryGuardApiResponse>({
      method: HttpMethod.POST,
      url: endpoint,
      headers,
      body: {
        content: context.propsValue.content,
        strict_mode: context.propsValue.strict_mode ?? true,
      },
    });
    const latencyMs = Number(
      (
        (typeof globalThis.performance?.now === 'function'
          ? globalThis.performance.now()
          : Date.now()) - t0
      ).toFixed(3)
    );

    const data = response.body ?? {};
    const threatsList = Array.isArray(data.threats_neutralized)
      ? data.threats_neutralized.filter((item): item is string => typeof item === 'string')
      : [];
    // Preserve empty string "" when strict_mode blocks malicious content rather than coalescing with `||`.
    const sanitizedContent = data.sanitized_content ?? '';
    const injectionDetected = Boolean(data.injection_detected);

    return {
      status: data.status ?? (injectionDetected ? 'blocked' : 'clean'),
      injection_detected: injectionDetected,
      risk_score: typeof data.risk_score === 'number' ? data.risk_score : null,
      sanitized_content: sanitizedContent,
      threats_neutralized: threatsList.join(', '),
      threat_count: threatsList.length,
      safety_receipt: typeof data.safety_receipt === 'string' ? data.safety_receipt : null,
      latency_ms: latencyMs,
      execution_mode: 'cloud_api',
      payment_mode: usePaid ? 'x402_header' : 'free_preview',
      upgrade_hint: usePaid
        ? null
        : 'Evaluated via free /v1/sanitize/preview. Provide a Base64 x402 v2 PAYMENT-SIGNATURE header for paid /v1/sanitize ($0.010 USDC/call on Base).',
    };
  },
});
