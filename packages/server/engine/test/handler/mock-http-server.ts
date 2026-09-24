import { createServer } from 'http'

const startMockHttpServer = async (): Promise<{
  baseUrl: string
  hits: Map<string, number>
  close: () => Promise<void>
}> => {
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    const hit = (hits.get(path) ?? 0) + 1
    hits.set(path, hit)
    res.setHeader('content-type', 'application/json')

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

    res.statusCode = 404
    res.end(
      JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        message: 'Route not found',
      }),
    )
  })

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

  return { baseUrl, hits, close }
}

export const mockHttpServer = { start: startMockHttpServer }
