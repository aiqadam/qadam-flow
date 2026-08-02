// The two bounds an AI provider response is held to. They live here because two processes enforce
// them over the same wait: the server times the outbound request
// (`packages/server/utils/src/safe-http.ts`), and the browser times the socket the answer arrives on
// (`packages/web/src/features/chat/lib/use-streaming-reducer.ts`). Keeping one literal per bound is
// the point — the browser carried its own flat 120s copy, #266 raised the server's first-byte
// allowance and the copy stayed behind, so the tab gave up on runs the server was still serving
// (#265, #289). The operator can raise either with AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS /
// AP_HTTP_STREAM_IDLE_TIMEOUT_SECONDS; these are only the defaults.
export const httpTimeouts = {
    // Five minutes of silence before the first byte. A cold local model loading gigabytes and
    // evaluating a large prompt routinely needs more than two; a provider that is genuinely dead
    // still gets reclaimed rather than pinning the socket.
    DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS: 300,
    // Once bytes are flowing, silence means broken rather than busy.
    DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS: 120,
}
