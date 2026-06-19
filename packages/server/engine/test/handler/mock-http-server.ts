import { createServer } from 'http'

const startMockHttpServer = async (): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> => {
  const server = createServer((_req, res) => {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
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

  return { baseUrl, close }
}

export const mockHttpServer = { start: startMockHttpServer }
