import type { Dispatcher } from 'undici'

// Node's built-in fetch (undici 7.21 in Node 24.14) appends its own Content-Length to one the caller
// already set, so the npm undici dispatcher the engine installs receives `"N, N"`. npm undici ≥ 7.26
// accepts digits only and rejects that before a socket opens (#677). Collapse the list to `N` when
// every entry is identical, and leave a mismatched list for undici to reject. Remove this once the
// image's Node ships a built-in undici ≥ 7.26, whose fetch no longer duplicates the header (Node
// 24.21 ships 7.29.1).
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
    if (hasSafeIterator(headers)) {
        return collapseIterable(headers)
    }
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, isContentLength(name) ? collapseValue(value) : value]))
}

// The same test undici's Request uses (`hasSafeIterator` in lib/core/util.js), so a header bag is
// read as pairs exactly when undici would read it as pairs: an inherited iterator on a plain object
// does not count.
function hasSafeIterator(headers: NonNullable<Dispatcher.DispatchOptions['headers']>): headers is Iterable<HeaderPair> {
    const prototype: unknown = Object.getPrototypeOf(headers)
    return Object.hasOwn(headers, Symbol.iterator)
        || (prototype !== null && prototype !== Object.prototype && Symbol.iterator in headers && typeof headers[Symbol.iterator] === 'function')
}

// Anything undici would reject (a non-callable own iterator, an entry that is not a two-element
// array) passes through untouched, so the caller gets undici's own error rather than one from here.
function collapseIterable(headers: Iterable<HeaderPair>): Iterable<HeaderPair> {
    if (typeof headers[Symbol.iterator] !== 'function') {
        return headers
    }
    const entries = Array.from(headers, (entry): HeaderPair => isPair(entry) && isContentLength(entry[0]) ? [entry[0], collapseValue(entry[1])] : entry)
    return { [Symbol.iterator]: () => entries[Symbol.iterator]() }
}

function isPair(entry: unknown): boolean {
    return Array.isArray(entry) && entry.length === 2
}

function isContentLength(name: unknown): boolean {
    return typeof name === 'string' && name.toLowerCase() === 'content-length'
}

// Only space and tab are optional whitespace around list members (RFC 9110 OWS). Trimming CR/LF as
// well would turn `"3\r\n, 3"` into a valid `3` instead of leaving undici to reject it.
function collapseValue<T>(value: T | string): T | string {
    if (typeof value !== 'string' || !value.includes(',')) {
        return value
    }
    const [first, ...rest] = value.split(',').map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ''))
    return rest.every((part) => part === first) ? first : value
}

type HeaderPair = [string, string | string[] | undefined]
