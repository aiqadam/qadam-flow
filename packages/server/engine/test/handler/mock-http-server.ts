import { createServer } from 'http'

const startMockHttpServer = async (): Promise<{
  baseUrl: string
  hits: Map<string, number>
  arrivals: { path: string, at: number }[]
  concurrency: { current: number, max: number }
  requests: { path: string, headers: Record<string, string | string[] | undefined>, body: unknown }[]
  close: () => Promise<void>
}> => {
  const hits = new Map<string, number>()
  const arrivals: { path: string, at: number }[] = []
  const concurrency = { current: 0, max: 0 }
  const requests: { path: string, headers: Record<string, string | string[] | undefined>, body: unknown }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ path: req.url ?? '', headers: req.headers, body: raw.length > 0 ? JSON.parse(raw) : undefined })
      route(req.url ?? '', res)
    })
  })

  const route = (path: string, res: import('http').ServerResponse): void => {
    const hit = (hits.get(path) ?? 0) + 1
    hits.set(path, hit)
    arrivals.push({ path, at: Date.now() })
    res.setHeader('content-type', 'application/json')

    // Answers after `ms`, counting how many requests are open at once — what a CONCURRENT loop's
    // cap is measured by (#387).
    if (path.startsWith('/slow')) {
      const ms = Number(new URL(path, 'http://mock').searchParams.get('ms') ?? '100')
      concurrency.current += 1
      concurrency.max = Math.max(concurrency.max, concurrency.current)
      setTimeout(() => {
        concurrency.current -= 1
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, path }))
      }, ms)
      return
    }

    // Telegram's shape for a 429: the wait is both in `parameters.retry_after` and in the
    // `Retry-After` header (tdlib/telegram-bot-api `Query::set_retry_after_error`).
    if (path.startsWith('/telegram-429')) {
      const retryAfter = new URL(path, 'http://mock').searchParams.get('retryAfter') ?? '1'
      const recoverAfter = Number(new URL(path, 'http://mock').searchParams.get('recoverAfter') ?? Infinity)
      if (hit > recoverAfter) {
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, result: { message_id: hit } }))
        return
      }
      res.statusCode = 429
      res.setHeader('retry-after', retryAfter)
      res.setHeader('set-cookie', 'session=do-not-leak')
      res.end(JSON.stringify({
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: { retry_after: Number(retryAfter) },
      }))
      return
    }

    // What a `callFlowForEach` step (#374) talks to: the flow lookup, the child webhooks (a body
    // whose `data.fail` is true is refused), and the parent's slot callbacks.
    if (path.startsWith('/v1/engine/populated-flows')) {
      res.statusCode = 200
      res.end(JSON.stringify({ data: [MOCK_CALLABLE_FLOW], next: null, previous: null }))
      return
    }
    if (path.startsWith('/v1/webhooks/')) {
      const body = requests[requests.length - 1]?.body
      const refused = typeof body === 'object' && body !== null && 'data' in body && typeof body.data === 'object' && body.data !== null && 'fail' in body.data && body.data.fail === true
      res.statusCode = refused ? 500 : 200
      res.end(JSON.stringify({}))
      return
    }
    if (path.startsWith('/slots/')) {
      res.statusCode = 200
      res.end(JSON.stringify({ message: 'recorded' }))
      return
    }

    res.statusCode = 404
    res.end(
      JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        message: 'Route not found',
      }),
    )
  }

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('mock-http-server failed to bind to a TCP port')
  }

  const baseUrl = `http://127.0.0.1:${address.port}`
  const close = (): Promise<void> =>
    new Promise((resolve) => server.close(() => resolve()))

  return { baseUrl, hits, arrivals, concurrency, requests, close }
}

const MOCK_CALLABLE_FLOW = {
  id: 'child-flow',
  externalId: 'child',
  status: 'ENABLED',
  version: {
    displayName: 'Child',
    trigger: { type: 'PIECE_TRIGGER', settings: { qadamName: '@aiqadam/qadam-subflows', input: { exampleData: {} } } },
  },
}

export const mockHttpServer = { start: startMockHttpServer }
