import { qadamVersionParser } from '../../../src/lib/automation/qadams/qadam-version'
import { getLegacyPackageAliasForQadam, getPackageAliasForQadam, trimVersionFromAlias } from '../../../src/lib/automation/qadams/utils'

// ADR-0004 "Pin format": a release `x.y.z` or a snapshot `x.y.z-main.<n>`, and nothing else.
describe('qadamVersionParser.parse', () => {
    it.each([
        ['1.2.3', { major: 1, minor: 2, patch: 3, snapshot: null }],
        ['0.0.0', { major: 0, minor: 0, patch: 0, snapshot: null }],
        ['10.20.30', { major: 10, minor: 20, patch: 30, snapshot: null }],
        ['1.3.0-main.412', { major: 1, minor: 3, patch: 0, snapshot: 412 }],
        ['2.0.0-main.0', { major: 2, minor: 0, patch: 0, snapshot: 0 }],
    ])('reads %s', (version, parsed) => {
        expect(qadamVersionParser.parse({ version })).toEqual(parsed)
    })

    it.each([
        ['1.2.3-rc.1', 'another prerelease'],
        ['1.2.3-beta', 'another prerelease'],
        ['1.2.3-main', 'a snapshot without its counter'],
        ['1.2.3-main.', 'an empty counter'],
        ['1.2.3-main.01', 'a counter with a leading zero'],
        ['1.2.3-main.4.5', 'a second counter'],
        ['1.2.3-main.4-x', 'a suffix after the counter'],
        ['1.2.3-MAIN.4', 'another case of the channel'],
        ['1.2.3-nightly.4', 'another channel'],
        ['1.2.3+build.5', 'build metadata'],
        ['1.2.3-main.4+build.5', 'a snapshot with build metadata'],
        ['01.2.3', 'a leading zero'],
        ['1.02.3', 'a leading zero'],
        ['1.2', 'two components'],
        ['1.2.3.4', 'four components'],
        ['v1.2.3', 'a tag name'],
        ['^1.2.3', 'a caret range'],
        ['~1.2.3', 'a tilde range'],
        ['>=1.2.3', 'a comparator'],
        ['1.x', 'a wildcard'],
        ['latest', 'a dist-tag'],
        ['', 'an empty string'],
        [' 1.2.3', 'leading whitespace'],
        ['1.2.3\n', 'a trailing newline'],
        ['1234567890.0.0', 'a component of ten digits'],
        ['1.2.3-main.1234567890', 'a counter of ten digits'],
    ])('rejects %j (%s)', (version) => {
        expect(qadamVersionParser.parse({ version })).toBeNull()
    })

    it('tells a release from a snapshot, and reads the base of either', () => {
        expect(qadamVersionParser.isRelease({ version: '1.3.0' })).toBe(true)
        expect(qadamVersionParser.isRelease({ version: '1.3.0-main.412' })).toBe(false)
        expect(qadamVersionParser.isSnapshot({ version: '1.3.0-main.412' })).toBe(true)
        expect(qadamVersionParser.isSnapshot({ version: '1.3.0' })).toBe(false)
        expect(qadamVersionParser.isSnapshot({ version: '1.3.0-rc.1' })).toBe(false)
        expect(qadamVersionParser.getBase({ version: '1.3.0-main.412' })).toBe('1.3.0')
        expect(qadamVersionParser.getBase({ version: '1.3.0' })).toBe('1.3.0')
        expect(qadamVersionParser.getBase({ version: '^1.3.0' })).toBeNull()
    })

    it('calls a version exact only when it carries no range', () => {
        expect(qadamVersionParser.isExact({ version: '1.3.0' })).toBe(true)
        expect(qadamVersionParser.isExact({ version: '1.3.0-main.412' })).toBe(true)
        expect(qadamVersionParser.isExact({ version: '^1.3.0' })).toBe(false)
        expect(qadamVersionParser.isExact({ version: '~1.3.0-main.412' })).toBe(false)
    })
})

describe('qadamVersionParser.parsePin', () => {
    it.each([
        ['1.2.3', null, null],
        ['^1.2.3', '^', null],
        ['~1.2.3', '~', null],
        ['1.3.0-main.412', null, 412],
        ['^1.3.0-main.412', '^', 412],
        ['~1.3.0-main.412', '~', 412],
    ])('reads %s', (pin, range, snapshot) => {
        const parsed = qadamVersionParser.parsePin({ pin })

        expect(parsed?.range).toBe(range)
        expect(parsed?.version.snapshot).toBe(snapshot)
    })

    it.each([
        ['^^1.2.3'],
        ['^1.2.3-rc.1'],
        ['>=1.2.3'],
        ['^1.2'],
        ['* '],
        ['latest'],
        [''],
    ])('rejects %j', (pin) => {
        expect(qadamVersionParser.parsePin({ pin })).toBeNull()
    })
})

describe('aliases', () => {
    it('joins the name and the version with @', () => {
        expect(getPackageAliasForQadam({ qadamName: '@aiqadam/qadam-tables', qadamVersion: '1.3.0-main.412' })).toBe('@aiqadam/qadam-tables@1.3.0-main.412')
        expect(getPackageAliasForQadam({ qadamName: 'qadam-a', qadamVersion: '1.0.0' })).toBe('qadam-a@1.0.0')
    })

    it('still builds the legacy alias for the compatibility read path', () => {
        expect(getLegacyPackageAliasForQadam({ qadamName: '@aiqadam/qadam-tables', qadamVersion: '1.3.0-main.412' })).toBe('@aiqadam/qadam-tables-1.3.0-main.412')
    })

    it.each([
        ['@aiqadam/qadam-tables@1.2.0', '@aiqadam/qadam-tables', '1.2.0', false],
        ['@aiqadam/qadam-tables@1.3.0-main.412', '@aiqadam/qadam-tables', '1.3.0-main.412', false],
        ['qadam-a@0.0.1', 'qadam-a', '0.0.1', false],
        ['@acme/qadam-a-1-2@2.0.0', '@acme/qadam-a-1-2', '2.0.0', false],
        ['@aiqadam/qadam-tables-1.2.0', '@aiqadam/qadam-tables', '1.2.0', true],
        ['@aiqadam/qadam-tables-1.3.0-main.412', '@aiqadam/qadam-tables', '1.3.0-main.412', true],
        ['qadam-a-0.0.1', 'qadam-a', '0.0.1', true],
        ['@acme/qadam-a-1-2-2.0.0', '@acme/qadam-a-1-2', '2.0.0', true],
    ])('splits %s into %s and %s (legacy: %s)', (alias, name, version, isLegacy) => {
        expect(qadamVersionParser.parseAlias({ alias })).toEqual({ name, version, isLegacy })
        expect(trimVersionFromAlias(alias)).toBe(name)
    })

    it.each([
        ['@aiqadam/qadam-tables'],
        ['qadam-tables'],
        ['@aiqadam/qadam-tables@latest'],
        ['@aiqadam/qadam-tables@1.2.3-rc.1'],
        ['@aiqadam/qadam-tables@^1.2.3'],
        ['@aiqadam/qadam-tables-1.2.3-rc.1'],
        [''],
    ])('finds no version in %j and leaves the alias whole', (alias) => {
        expect(qadamVersionParser.parseAlias({ alias })).toBeNull()
        expect(trimVersionFromAlias(alias)).toBe(alias)
    })

    it('splits a snapshot alias at the name, not at the hyphen of -main.<n>', () => {
        const alias = getPackageAliasForQadam({ qadamName: '@aiqadam/qadam-tables', qadamVersion: '1.3.0-main.412' })

        expect(trimVersionFromAlias(alias)).toBe('@aiqadam/qadam-tables')
        expect(trimVersionFromAlias(getLegacyPackageAliasForQadam({ qadamName: '@aiqadam/qadam-tables', qadamVersion: '1.3.0-main.412' }))).toBe('@aiqadam/qadam-tables')
    })
})
