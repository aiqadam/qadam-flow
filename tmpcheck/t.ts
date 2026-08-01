type Custom = { provider: 'custom', displayName: string, config: { baseUrl: string, models: string[] }, auth: { apiKey: string } }
type OpenAI = { provider: 'openai', displayName: string, config: {}, auth: { apiKey: string } }
type Union = Custom | OpenAI
type Create = Union & { enabledForChat?: boolean }

function f(values: Create) {
    if (values.provider === 'custom') {
        const m: string[] = values.config.models
        return m
    }
    return []
}
// property access on the intersection
function g(v: Create) { return v.displayName + String(v.enabledForChat) }
