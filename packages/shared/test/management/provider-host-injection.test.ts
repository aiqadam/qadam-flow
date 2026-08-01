import { formErrors } from '../../src/lib/form-errors'
import { AIProviderName, AzureProviderConfig, BedrockProviderConfig, isValidAwsRegion, isValidAzureResourceName, parseProviderConfig } from '../../src/lib/management/ai-providers'

// `resourceName` becomes the leftmost label of `<it>.openai.azure.com`, so anything that can end
// the label re-points the whole request — and the `api-key` header goes with it (#276). Each
// rejected case below is a working host injection, not a cosmetic typo.
describe('AzureProviderConfig.resourceName', () => {
    it.each([
        ['the exploit from the issue', 'attacker.example.com/'],
        ['a bare dot', 'my.resource'],
        ['a slash', 'my-resource/x'],
        ['a backslash', 'my-resource\\x'],
        ['userinfo', 'attacker.example.com@my-resource'],
        ['a port', 'attacker.example.com:8443'],
        ['a query', 'my-resource?x=1'],
        ['a fragment', 'my-resource#x'],
        ['a leading space', ' my-resource'],
        ['a trailing space', 'my-resource '],
        ['an inner space', 'my resource'],
        ['a newline', 'my-resource\nx'],
        ['an underscore', 'my_resource'],
        ['a full url', 'https://attacker.example.com'],
        ['empty', ''],
        ['one character', 'a'],
        ['sixty-five characters', 'a'.repeat(65)],
    ])('rejects %s', (_label, resourceName) => {
        const result = AzureProviderConfig.safeParse({ resourceName })

        expect(result.success).toBe(false)
        expect(isValidAzureResourceName(resourceName)).toBe(false)
    })

    it.each([
        ['a typical name', 'my-openai-resource'],
        ['digits', 'contoso123'],
        ['the two-character minimum', 'ab'],
        ['the sixty-four-character maximum', 'a'.repeat(64)],
        ['mixed case', 'MyOpenAIResource'],
    ])('accepts %s', (_label, resourceName) => {
        const result = AzureProviderConfig.safeParse({ resourceName })

        expect(result.success).toBe(true)
        expect(isValidAzureResourceName(resourceName)).toBe(true)
    })

    it('reports an i18n key rather than an English sentence', () => {
        const result = AzureProviderConfig.safeParse({ resourceName: 'attacker.example.com/' })

        expect(result.success).toBe(false)
        expect(result.error?.issues.map(issue => issue.message)).toContain(formErrors.invalidAzureResourceName)
    })

    it('keeps apiVersion optional for a valid resource name', () => {
        expect(AzureProviderConfig.safeParse({ resourceName: 'my-resource', apiVersion: '' }).data)
            .toEqual({ resourceName: 'my-resource', apiVersion: undefined })
    })

    // `update` re-parses an incoming config through this, so a rejected `resourceName` must come
    // back as null there rather than falling through to an empty union member and being stored.
    it('makes parseProviderConfig reject an azure config carrying an injected host', () => {
        expect(parseProviderConfig({ provider: AIProviderName.AZURE, config: { resourceName: 'attacker.example.com/' } }))
            .toBeNull()
        expect(parseProviderConfig({ provider: AIProviderName.AZURE, config: { resourceName: 'my-resource' } }))
            .toEqual({ resourceName: 'my-resource', apiVersion: undefined })
    })

    it('does not treat a non-string as a resource name', () => {
        expect(isValidAzureResourceName(undefined)).toBe(false)
        expect(isValidAzureResourceName(null)).toBe(false)
        expect(isValidAzureResourceName(1234)).toBe(false)
    })
})

// `@aws-sdk/client-bedrock` builds `https://bedrock.{region}.amazonaws.com` and validates nothing,
// so `region` is the same host injection as `resourceName` — checked against the installed SDK:
// `evil.com/` resolves to host `bedrock.evil.com`, `x@evil.com` to `evil.com.amazonaws.com`.
describe('BedrockProviderConfig.region', () => {
    it.each([
        ['a trailing slash', 'evil.com/'],
        ['userinfo', 'x@evil.com'],
        ['a fragment', 'evil.com#'],
        ['a dot', 'us-east-1.evil.com'],
        ['a colon', 'us-east-1:443'],
        ['whitespace', 'us east 1'],
        ['uppercase', 'US-EAST-1'],
        ['an underscore', 'us_east_1'],
        ['empty', ''],
    ])('rejects %s', (_label, region) => {
        expect(BedrockProviderConfig.safeParse({ region }).success).toBe(false)
        expect(isValidAwsRegion(region)).toBe(false)
    })

    it.each([
        ['a commercial region', 'us-east-1'],
        ['an asia-pacific region', 'ap-southeast-2'],
        ['a govcloud region', 'us-gov-west-1'],
        ['a china region', 'cn-north-1'],
    ])('accepts %s', (_label, region) => {
        expect(BedrockProviderConfig.safeParse({ region }).success).toBe(true)
        expect(isValidAwsRegion(region)).toBe(true)
    })

    it('reports an i18n key rather than an English sentence', () => {
        const result = BedrockProviderConfig.safeParse({ region: 'evil.com/' })

        expect(result.error?.issues.map(issue => issue.message)).toContain(formErrors.invalidAwsRegion)
    })

    it('does not treat a non-string as a region', () => {
        expect(isValidAwsRegion(undefined)).toBe(false)
        expect(isValidAwsRegion(null)).toBe(false)
    })
})
