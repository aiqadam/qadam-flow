import { betterstackTransport } from './betterstack-transport'
import { lokiTransport } from './loki-transport'
import { otelTransport } from './otel-transport'
import { TransportProvider } from './transport-provider'

export const transportProviders: TransportProvider[] = [
    lokiTransport,
    betterstackTransport,
    otelTransport,
]
