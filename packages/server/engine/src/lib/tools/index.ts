import { Action, DropdownOption, ExecutePropsResult, PropertyType, QadamProperty } from '@aiqadam/qadams-framework'
import { AgentQadamTool, ExecuteToolOperation, ExecuteToolResponse, executionJournal, ExecutionToolStatus, FieldControlMode, FlowActionType, isNil, PropertyExecutionType, QadamAction, StepOutputStatus, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { generateText, LanguageModel, NoObjectGeneratedError, Output, Tool, zodSchema } from 'ai'
import dayjs from 'dayjs'
import { z } from 'zod'
import { EngineConstants } from '../handler/context/engine-constants'
import { FlowExecutorContext } from '../handler/context/flow-execution-context'
import { flowExecutor } from '../handler/flow-executor'
import { qadamHelper } from '../helper/qadam-helper'
import { qadamLoader } from '../helper/qadam-loader'
import { tsort } from './tsort'

export const agentTools = {
    async tools({ engineConstants, insideConcurrentIteration, tools, model }: ConstructToolParams): Promise<Record<string, Tool>> {
        const qadamTools = await Promise.all(tools.map(async (tool) => {
            const { qadamAction } = await qadamLoader.getQadamAndActionOrThrow({
                qadamName: tool.qadamMetadata.qadamName,
                qadamVersion: tool.qadamMetadata.qadamVersion,
                actionName: tool.qadamMetadata.actionName,
                devQadams: EngineConstants.DEV_QADAMS,
            })
            return {
                name: tool.toolName,
                description: qadamAction.description,
                inputSchema: z.object({
                    instruction: z.string().describe('The instruction to the tool'),
                }),
                execute: async ({ instruction }: { instruction: string }) =>
                    execute({
                        operation: {
                            ...engineConstants,
                            instruction,
                            qadamName: tool.qadamMetadata.qadamName,
                            qadamVersion: tool.qadamMetadata.qadamVersion,
                            actionName: tool.qadamMetadata.actionName,
                            predefinedInput: tool.qadamMetadata.predefinedInput,
                            model,
                        },
                        constants: EngineConstants.fromAgentToolCall({ parent: engineConstants, insideConcurrentIteration }),
                    }),
            }
        }))

        return {
            ...Object.fromEntries(qadamTools.map((tool) => [tool.name, tool])),
        }
    },
}

const MAX_REJECTED_TEXT_LENGTH = 4000
const REASONING_CLOSING_TAG = '</think>'

async function resolveProperties({
    depthToPropertyMap,
    instruction,
    action,
    model,
    operation,
}: ResolvePropertiesParams): Promise<Record<string, unknown>> {
    const auth = operation.predefinedInput?.auth
    const predefinedInputsFields = operation.predefinedInput?.fields || {}

    let result: Record<string, unknown> = {}

    if (auth) {
        result.auth = auth
    }

    for (const [propertyName, field] of Object.entries(predefinedInputsFields)) {
        if (field.mode === FieldControlMode.CHOOSE_YOURSELF) {
            result[propertyName] = field.value
        }
        else if (field.mode === FieldControlMode.LEAVE_EMPTY) {
            result[propertyName] = undefined
        }
    }

    for (const [_, properties] of Object.entries(depthToPropertyMap)) {
        const propertyToFill: Record<string, PropertySchemas> = {}
        const propertyDetails: PropertyDetail[] = []

        for (const property of properties) {
            const propertyFromAction = action.props[property]
            const propertyType = propertyFromAction.type
            const skipTypes = [
                PropertyType.BASIC_AUTH,
                PropertyType.OAUTH2,
                PropertyType.CUSTOM_AUTH,
                PropertyType.CUSTOM,
                PropertyType.MARKDOWN,
            ]
            if (skipTypes.includes(propertyType) || property in result) {
                continue
            }

            propertyToFill[property] = await propertyToSchema({
                propertyName: property,
                property: propertyFromAction,
                operation,
                resolvedInput: result,
            })

            const propertyDetail = await buildPropertyDetail(
                property,
                propertyFromAction,
                operation,
                result,
            )
            if (!isNil(propertyDetail)) {
                propertyDetails.push(propertyDetail)
            }
        }

        if (Object.keys(propertyToFill).length === 0) continue

        const schemas: ExtractionSchemas = {
            strict: z.object(pickSchemas({ propertySchemas: propertyToFill, variant: 'strict' })).strict(),
            lenient: z.object(pickSchemas({ propertySchemas: propertyToFill, variant: 'lenient' })),
        }
        const extractionPrompt = constructExtractionPrompt({
            instruction,
            propertyNames: Object.keys(propertyToFill),
            jsonSchema: JSON.stringify(z.toJSONSchema(schemas.strict)),
            propertyDetails,
            existingValues: result,
        })

        const output = await extractProperties({ model, prompt: extractionPrompt, schemas })

        result = {
            ...result,
            ...output,
        }

    }
    return result
}

async function execute({ operation, constants }: ExecuteParams): Promise<ExecuteToolResponse> {
    try {
        const { qadamAction } = await qadamLoader.getQadamAndActionOrThrow({
            qadamName: operation.qadamName,
            qadamVersion: operation.qadamVersion,
            actionName: operation.actionName,
            devQadams: EngineConstants.DEV_QADAMS,
        })
        const depthToPropertyMap = tsort.sortPropertiesByDependencies(qadamAction.props)
        const resolvedInput = await resolveProperties({
            depthToPropertyMap,
            instruction: operation.instruction,
            action: qadamAction,
            model: operation.model,
            operation,
        })
        
        const step: QadamAction = {
            name: operation.actionName,
            displayName: operation.actionName,
            type: FlowActionType.PIECE,
            lastUpdatedDate: dayjs().toISOString(),
            settings: {
                input: resolvedInput,
                actionName: operation.actionName,
                qadamName: operation.qadamName,
                qadamVersion: operation.qadamVersion,
                propertySettings: Object.fromEntries(Object.entries(resolvedInput).map(([key]) => [key, {
                    type: PropertyExecutionType.MANUAL,
                    schema: undefined,
                }])),
            },
            valid: true,
        }
        const output = await flowExecutor.getExecutorForAction(step.type).handle({
            action: step,
            executionState: FlowExecutorContext.empty(),
            constants,
        })
        // `operation.actionName` is qadam-author-controlled, and `STEP_NAME_REGEX` admits
        // `constructor`/`toString`/`valueOf`/`hasOwnProperty`/`__proto__`. `Object.hasOwn`, not a
        // bare index: a bare read for an action name that never produced a step resolves those
        // names off `Object.prototype` instead of `undefined`, which would report `SUCCESS` with
        // an `undefined` output for an action that never ran.
        const stepResult = executionJournal.getOwnStep({ target: output.steps, stepName: operation.actionName })
        if (isNil(stepResult)) {
            throw new Error(`No step output found for action "${operation.actionName}"`)
        }
        const { output: stepOutput, errorMessage, status } = stepResult

        return {
            status: status === StepOutputStatus.FAILED ? ExecutionToolStatus.FAILED : ExecutionToolStatus.SUCCESS,
            output: stepOutput,
            resolvedInput: {
                ...resolvedInput,
                auth: 'Redacted',
            },
            errorMessage,
        }
    }
    catch (error) {
        return {
            status: ExecutionToolStatus.FAILED,
            output: undefined,
            resolvedInput: {},
            errorMessage: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
}

const constructExtractionPrompt = ({
    instruction,
    propertyNames,
    jsonSchema,
    propertyDetails,
    existingValues,
}: ConstructExtractionPromptParams): string => {
    const existingValuesContext = Object.keys(existingValues).length > 0
        ? buildExistingValuesSection(existingValues)
        : ''

    const propertyDetailsSection = propertyDetails.length > 0
        ? buildPropertyDetailsSection(propertyDetails)
        : ''

    return `
You are an expert at understanding API schemas and filling out properties based on user instructions.

**TASK**:
- Fill out the properties "${propertyNames.join('", "')}" based on the user's instructions.
- Output must be a valid JSON object matching the schema.

**USER INSTRUCTIONS**:
${instruction}

${existingValuesContext}

${propertyDetailsSection}

**JSON SCHEMA** (the output MUST validate against it):
${jsonSchema}

**RULES** (MUST FOLLOW):
- For dropdown, multi-select dropdown, and static dropdown properties: Select values ONLY from the provided options array. Use the 'value' field from the option objects.
- For array properties: Select values ONLY from the provided options array if specified.
- For dynamic properties: Select values ONLY from the provided options array if specified.
- Options format: [{ label: string, value: string | object | number | boolean }]
- For DATE_TIME properties: Use ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)
- Use actual values from the user instructions to determine property values.
- Use already filled values as context for consistency.
- Required properties: MUST include all, even if missing from instructions. Infer reasonable defaults or look for hints if possible.
- Optional properties: set them to null if no information is available—do not invent values, and never omit a key the schema lists as required.
- Do not add extra properties outside the requested ones.
- Ensure output is parseable JSON without additional text.
`
}

async function propertyToSchema({ propertyName, property, operation, resolvedInput }: PropertyToSchemaParams): Promise<PropertySchemas> {
    const schemas = await baseSchemasForProperty({ propertyName, property, operation, resolvedInput })
    const strict = property.description ? schemas.strict.describe(property.description) : schemas.strict
    const lenient = property.description ? schemas.lenient.describe(property.description) : schemas.lenient
    // The strict schema keeps every key required because OpenAI's strict structured output
    // rejects optional keys; the lenient one is what we accept back from a model that ignored it.
    return property.required
        ? { strict, lenient }
        : { strict: strict.nullable(), lenient: lenient.nullish() }
}

async function baseSchemasForProperty({ propertyName, property, operation, resolvedInput }: PropertyToSchemaParams): Promise<PropertySchemas> {
    switch (property.type) {
        case PropertyType.SHORT_TEXT:
        case PropertyType.LONG_TEXT:
        case PropertyType.MARKDOWN:
        case PropertyType.DATE_TIME:
        case PropertyType.FILE:
        case PropertyType.COLOR:
            return sameSchemas(z.string())
        case PropertyType.DROPDOWN:
        case PropertyType.STATIC_DROPDOWN:
            return sameSchemas(z.union([z.string(), z.number(), z.object({}).loose()]))
        case PropertyType.MULTI_SELECT_DROPDOWN:
        case PropertyType.STATIC_MULTI_SELECT_DROPDOWN:
            return sameSchemas(z.union([z.array(z.string()), z.array(z.object({}).loose())]))
        case PropertyType.NUMBER:
            return sameSchemas(z.number())
        case PropertyType.ARRAY: {
            if (property.properties) {
                const item = await buildObjectSchemaFromProperties({ properties: property.properties, operation, resolvedInput })
                return { strict: z.array(item.strict), lenient: z.array(item.lenient) }
            }
            return sameSchemas(z.array(z.union([z.string(), z.number(), z.boolean(), z.object({}).loose()])))
        }
        case PropertyType.OBJECT:
            return sameSchemas(z.object({}).loose())
        case PropertyType.JSON:
            return sameSchemas(z.union([z.object({}).loose(), z.array(z.unknown())]))
        case PropertyType.DYNAMIC:
            return buildDynamicSchema({ propertyName, operation, resolvedInput })
        case PropertyType.CHECKBOX:
            return sameSchemas(z.boolean())
        case PropertyType.CUSTOM:
            return sameSchemas(z.string())
        case PropertyType.OAUTH2:
        case PropertyType.BASIC_AUTH:
        case PropertyType.CUSTOM_AUTH:
        case PropertyType.SECRET_TEXT:
            throw new Error(`Unsupported property type: ${property.type}`)
    }
}

function sameSchemas(schema: z.ZodTypeAny): PropertySchemas {
    return { strict: schema, lenient: schema }
}

function pickSchemas({ propertySchemas, variant }: PickSchemasParams): Record<string, z.ZodTypeAny> {
    return Object.fromEntries(Object.entries(propertySchemas).map(([name, schemas]) => [name, schemas[variant]]))
}

async function buildObjectSchemaFromProperties({ properties, operation, resolvedInput }: BuildObjectSchemaParams): Promise<PropertySchemas> {
    const entries = Object.entries(properties)
    const schemas = await Promise.all(entries.map(([key, value]) =>
        propertyToSchema({ propertyName: key, property: value, operation, resolvedInput }),
    ))
    const propertySchemas = Object.fromEntries(entries.map(([key], i) => [key, schemas[i]]))
    return {
        strict: z.object(pickSchemas({ propertySchemas, variant: 'strict' })).loose(),
        lenient: z.object(pickSchemas({ propertySchemas, variant: 'lenient' })).loose(),
    }
}

async function buildDynamicSchema({ propertyName, operation, resolvedInput }: BuildDynamicSchemaParams): Promise<PropertySchemas> {
    const response = await qadamHelper.executeProps({
        ...operation,
        propertyName,
        actionOrTriggerName: operation.actionName,
        input: resolvedInput,
        sampleData: {},
        searchValue: undefined,
    }) as unknown as ExecutePropsResult<PropertyType.DYNAMIC>
    return buildObjectSchemaFromProperties({ properties: response.options, operation, resolvedInput })
}

// Models reached through an OpenAI-compatible endpoint get only `response_format: json_object`,
// never the schema, so their answer routinely drops nullable keys the strict schema requires.
// Accept such an answer when it satisfies the lenient schema, and otherwise ask once more with
// the validation errors spelled out before failing the tool call.
async function extractProperties({ model, prompt, schemas }: ExtractPropertiesParams): Promise<Record<string, unknown>> {
    const firstAttempt = await attemptExtraction({ model, prompt, schemas })
    if (firstAttempt.success) {
        return firstAttempt.output
    }
    const retryAttempt = await attemptExtraction({
        model,
        prompt: buildRetryPrompt({ prompt, rejected: firstAttempt }),
        schemas,
    })
    if (retryAttempt.success) {
        return retryAttempt.output
    }
    throw new Error(`Could not fill the tool's properties from the model's response: ${retryAttempt.problems}`)
}

async function attemptExtraction({ model, prompt, schemas }: ExtractPropertiesParams): Promise<ExtractionAttempt> {
    const generation = await tryCatch(() => generateText({
        model,
        prompt,
        output: Output.object({ schema: zodSchema(schemas.strict) }),
    }))
    if (generation.error === null) {
        return { success: true, output: generation.data.output }
    }
    if (!NoObjectGeneratedError.isInstance(generation.error)) {
        throw generation.error
    }
    const rejectedText = generation.error.text ?? ''
    const candidate = parseJsonObject(rejectedText)
    if (isNil(candidate)) {
        return { success: false, rejectedText, problems: 'the response is not a JSON object' }
    }
    const lenientResult = schemas.lenient.safeParse(candidate)
    if (lenientResult.success) {
        return { success: true, output: lenientResult.data }
    }
    return { success: false, rejectedText, problems: z.prettifyError(lenientResult.error) }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    const answer = stripReasoning(text)
    const start = answer.indexOf('{')
    const end = answer.lastIndexOf('}')
    if (start === -1 || end < start) {
        return null
    }
    // The AI SDK's own parser rejects `__proto__`; a nested one surviving here would be copied onto
    // a `.loose()` object by assignment and swap its prototype, hiding the value from the run log.
    const parsed = tryCatchSync((): unknown => JSON.parse(answer.slice(start, end + 1), (key, value) => key === '__proto__' ? undefined : value))
    return isJsonObject(parsed.data) ? parsed.data : null
}

function stripReasoning(text: string): string {
    const reasoningEnd = text.lastIndexOf(REASONING_CLOSING_TAG)
    return reasoningEnd === -1 ? text : text.slice(reasoningEnd + REASONING_CLOSING_TAG.length)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildRetryPrompt({ prompt, rejected }: BuildRetryPromptParams): string {
    return `${prompt}
**YOUR PREVIOUS RESPONSE WAS REJECTED**:
${rejected.rejectedText.slice(0, MAX_REJECTED_TEXT_LENGTH)}

**VALIDATION ERRORS**:
${rejected.problems}

Return the corrected JSON object only.
`
}

type PropertyDetail = {
    name: string
    type: PropertyType
    description?: string
    options?: DropdownOption<unknown>[]
    defaultValue?: unknown
}

async function buildPropertyDetail(propertyName: string, property: QadamProperty, operation: ExecuteToolOperation, input: Record<string, unknown>): Promise<PropertyDetail | null> {
    const baseDetail: PropertyDetail = {
        name: propertyName,
        type: property.type,
        description: property.description,
        defaultValue: property.defaultValue,
    }

    if (
        property.type === PropertyType.DROPDOWN ||
        property.type === PropertyType.MULTI_SELECT_DROPDOWN ||
        property.type === PropertyType.STATIC_DROPDOWN ||
        property.type === PropertyType.STATIC_MULTI_SELECT_DROPDOWN
    ) {
        const options = await loadOptions(propertyName, property, operation, input)
        return {
            ...baseDetail,
            options,
        }
    }

    return baseDetail
}

async function loadOptions(propertyName: string, property: QadamProperty, operation: ExecuteToolOperation, input: Record<string, unknown>): Promise<DropdownOption<unknown>[]> {
    if (property.type === PropertyType.STATIC_DROPDOWN || property.type === PropertyType.STATIC_MULTI_SELECT_DROPDOWN) {
        const staticProperty = property as { options: { options: DropdownOption<unknown>[] } }
        return staticProperty.options.options
    }
    
    const response = await qadamHelper.executeProps({
        ...operation,
        propertyName,
        actionOrTriggerName: operation.actionName,
        input,
        sampleData: {},
        searchValue: undefined,
    }) as unknown as ExecutePropsResult<PropertyType.DROPDOWN | PropertyType.MULTI_SELECT_DROPDOWN>
    const options = response.options
    return options.options
}

function buildExistingValuesSection(existingValues: Record<string, unknown>): string {
    return `
**ALREADY FILLED VALUES** (use for context and consistency):
${JSON.stringify(existingValues, null, 2)}
`
}

function buildPropertyDetailsSection(propertyDetails: PropertyDetail[]): string {
    const sections = propertyDetails.map(detail => {
        let content = `- Name: ${detail.name}\n  Type: ${detail.type}`
        if (detail.description) {
            content += `\n  Description: ${detail.description}`
        }
        if (detail.options && detail.options.length > 0) {
            content += `\n  Options: ${JSON.stringify(detail.options, null, 2)}`
        }
        return content
    }).join('\n\n')

    return `
**PROPERTY DETAILS**:
${sections}
`
}

type ExecuteToolOperationWithModel = ExecuteToolOperation & {
    model: LanguageModel
}

type ExecuteParams = {
    operation: ExecuteToolOperationWithModel
    constants: EngineConstants
}

type ConstructToolParams = {
    engineConstants: EngineConstants
    insideConcurrentIteration: boolean
    tools: AgentQadamTool[]
    model: LanguageModel
}

type ResolvePropertiesParams = {
    depthToPropertyMap: Record<number, string[]>
    instruction: string
    action: Action
    model: LanguageModel
    operation: ExecuteToolOperation
}

type PropertySchemas = {
    strict: z.ZodTypeAny
    lenient: z.ZodTypeAny
}

type ExtractionSchemas = {
    strict: z.ZodObject<Record<string, z.ZodTypeAny>>
    lenient: z.ZodObject<Record<string, z.ZodTypeAny>>
}

type ExtractionAttempt =
    | { success: true, output: Record<string, unknown> }
    | { success: false, rejectedText: string, problems: string }

type PropertyToSchemaParams = {
    propertyName: string
    property: QadamProperty
    operation: ExecuteToolOperation
    resolvedInput: Record<string, unknown>
}

type PickSchemasParams = {
    propertySchemas: Record<string, PropertySchemas>
    variant: keyof PropertySchemas
}

type BuildObjectSchemaParams = {
    properties: Record<string, QadamProperty>
    operation: ExecuteToolOperation
    resolvedInput: Record<string, unknown>
}

type BuildDynamicSchemaParams = {
    propertyName: string
    operation: ExecuteToolOperation
    resolvedInput: Record<string, unknown>
}

type ExtractPropertiesParams = {
    model: LanguageModel
    prompt: string
    schemas: ExtractionSchemas
}

type BuildRetryPromptParams = {
    prompt: string
    rejected: { rejectedText: string, problems: string }
}

type ConstructExtractionPromptParams = {
    instruction: string
    propertyNames: string[]
    jsonSchema: string
    propertyDetails: PropertyDetail[]
    existingValues: Record<string, unknown>
}
