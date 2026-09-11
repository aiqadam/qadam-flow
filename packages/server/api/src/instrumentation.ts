import { FastifyOtelInstrumentation } from '@fastify/otel'
import { Context } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { BatchSpanProcessor, ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { system } from './app/helper/system/system'
import { AppSystemProp } from './app/helper/system/system-props'

const ATTRIBUTES_TO_DROP = ['db.statement']
const URL_ATTRIBUTES = ['url.full', 'http.url']
/**
 * Some APIs — Telegram's is the one we call — put the credential in the URL path, and the HTTP
 * instrumentations record the full URL. Without this, enabling tracing exports a working bot token
 * on every request span, continuously, to whoever can read the tracing backend.
 */
const CREDENTIAL_IN_PATH_PATTERNS = [/\/bot\d+:[\w-]+/g]

function redactCredentialsInUrl(url: string): string {
    return CREDENTIAL_IN_PATH_PATTERNS.reduce(
        (redacted, pattern) => redacted.replace(pattern, '/bot[REDACTED]'),
        url,
    )
}

class FilteringSpanProcessor implements SpanProcessor {
    constructor(private readonly delegate: BatchSpanProcessor) {}

    onStart(span: Span, parentContext: Context): void {
        this.delegate.onStart(span, parentContext)
    }

    onEnd(span: ReadableSpan): void {
        for (const attr of ATTRIBUTES_TO_DROP) {
            Reflect.deleteProperty(span.attributes, attr)
        }
        for (const attr of URL_ATTRIBUTES) {
            const value = span.attributes[attr]
            if (typeof value === 'string') {
                span.attributes[attr] = redactCredentialsInUrl(value)
            }
        }
        this.delegate.onEnd(span)
    }

    shutdown(): Promise<void> {
        return this.delegate.shutdown()
    }

    forceFlush(): Promise<void> {
        return this.delegate.forceFlush()
    }
}

function getServiceName(): string {
    const isApp = system.isApp()
    const serviceName = isApp ? 'qadam-flow-api' : 'qadam-flow-worker'

    return serviceName
}

// getBoolean, not get: the raw string 'false' is truthy, so AP_OTEL_ENABLED=false used to *enable*
// tracing — which is also how the credential-in-URL export above could be on without anyone asking.
if (system.getBoolean(AppSystemProp.OTEL_ENABLED) ?? false) {
    const traceExporter = new OTLPTraceExporter()

    const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: getServiceName(),
    })

    const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 60_000,
    })

    const sdk = new NodeSDK({
        spanProcessors: [new FilteringSpanProcessor(new BatchSpanProcessor(traceExporter))],
        metricReader,
        resource,
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-net': { enabled: false },
            }),
            new FastifyOtelInstrumentation({
                servername: getServiceName(),
                registerOnInitialization: true,
            }),
        ],
    })

    sdk.start()
}