const MAX_PREFIX_LENGTH = 53

function shortHash(str: string): string {
    let h = 5381
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0
    }
    return h.toString(36).padStart(6, '0').slice(-6)
}

/**
 * Normalizes a string for use as an agent tool name.
 * Format: {prefix_up_to_53_chars}_{6char_hash}_mcp (≤ 64 chars total)
 */
function createToolName(name: string): string {
    const sanitized = name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
    const prefix = sanitized.slice(0, MAX_PREFIX_LENGTH)
    const hash = shortHash(sanitized)
    return `${prefix}_${hash}_mcp`
}

/**
 * Strips the @scope/qadam- prefix from qadamName (e.g. @aiqadam/qadam-slack → slack)
 * and delegates to createToolName.
 */
function createQadamToolName(qadamName: string, actionName: string): string {
    const QADAM_NAME_PREFIX = 'qadam-'
    const idx = qadamName.indexOf(QADAM_NAME_PREFIX)
    const shortQadamName = idx >= 0 ? qadamName.substring(idx + QADAM_NAME_PREFIX.length) : qadamName
    return createToolName(`${shortQadamName}-${actionName}`)
}

export const mcpToolNameUtils = {
    createToolName,
    createQadamToolName,
}
