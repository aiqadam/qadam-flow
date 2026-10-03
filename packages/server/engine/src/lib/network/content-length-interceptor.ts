import type { Dispatcher } from 'undici'

// Node's built-in fetch (undici 7.21 in Node 24.14) appends its own Content-Length to one the caller
// already set, so the npm undici dispatcher the engine installs receives `"N, N"`. npm undici ≥ 7.26
// accepts digits only and rejects that before a socket opens (#677). Collapse the list to `N` when
// every entry is identical, and leave a mismatched list for undici to reject. Remove this once the
// image's Node ships a built-in undici ≥ 7.26.
export const collapseDuplicateContentLength: Dispatcher.DispatcherComposeInterceptor = (dispatch) => {
    return (options, handler) => dispatch({ ...options, headers: collapseHeaders(options.headers) }, handler)
}

function collapseHeaders(headers: Dispatcher.DispatchOptions['headers']): Dispatcher.DispatchOptions['headers'] {
    if (headers === null || headers === undefined) {
        return headers
    }
    if (Array.isArray(headers)) {
        return headers.map((value, index) => index % 2 === 1 && isContentLength(headers[index - 1]) ? collapseValue(value) : value)
    }
    if (isPairIterable(headers)) {
        const pairs = Array.from(headers, ([name, value]): [string, string | string[] | undefined] => [name, isContentLength(name) ? collapseValue(value) : value])
        return { [Symbol.iterator]: () => pairs[Symbol.iterator]() }
    }
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, isContentLength(name) ? collapseValue(value) : value]))
}

function isPairIterable(headers: NonNullable<Dispatcher.DispatchOptions['headers']>): headers is Iterable<[string, string | string[] | undefined]> {
    return Symbol.iterator in headers && typeof headers[Symbol.iterator] === 'function'
}

function isContentLength(name: unknown): boolean {
    return typeof name === 'string' && name.toLowerCase() === 'content-length'
}

function collapseValue<T>(value: T | string): T | string {
    if (typeof value !== 'string' || !value.includes(',')) {
        return value
    }
    const [first, ...rest] = value.split(',').map((part) => part.trim())
    return rest.every((part) => part === first) ? first : value
}
