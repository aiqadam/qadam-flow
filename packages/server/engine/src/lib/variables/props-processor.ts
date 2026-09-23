import { DynamicProperties, getAuthPropertyForValue, InputPropertyMap, PropertyContext, PropertyType, QadamAuthProperty, QadamProperty, QadamPropertyMap, StaticPropsValue } from '@aiqadam/qadams-framework'
import { AppConnectionValue, AUTHENTICATION_PROPERTY_NAME, ExecutionError, ExecutionErrorType, isNil, isObject, PropertySettings, tryCatch } from '@aiqadam/shared'
import { processors } from './processors'
import { arrayZipperProcessor } from './processors/array-zipper'
import { FILE_VALUE_FORMS } from './processors/file'
import { PropertyProcessingError } from './processors/property-processing-error'

export const propsProcessor = {
    applyProcessorsAndValidators: async ({
        resolvedInput,
        props,
        auth,
        requireAuth,
        propertySettings,
        propertyContext,
    }: ApplyProcessorsAndValidatorsParams): Promise<{ processedInput: StaticPropsValue<QadamPropertyMap>, errors: PropsValidationError }> => {
        const processedInput = { ...resolvedInput }
        const errors: PropsValidationError = {}
        const processingErrors = new Map<string, string[]>()
        const authValue: AppConnectionValue | undefined = resolvedInput[AUTHENTICATION_PROPERTY_NAME]
        if (authValue && requireAuth) {
            const authPropsToProcess = getAuthPropsToProcess(authValue, auth)
            if (authPropsToProcess) {
                const { processedInput: authProcessedInput, errors: authErrors } = await propsProcessor.applyProcessorsAndValidators({
                    resolvedInput: resolvedInput[AUTHENTICATION_PROPERTY_NAME],
                    props: authPropsToProcess,
                    auth: undefined,
                    requireAuth: false,
                    propertySettings: {},
                })
                processedInput[AUTHENTICATION_PROPERTY_NAME] = authProcessedInput
                if (Object.keys(authErrors).length > 0) {
                    errors[AUTHENTICATION_PROPERTY_NAME] = authErrors
                }
            }
        }
        for (const [key, value] of Object.entries(resolvedInput)) {
            const property = getOwn({ record: props, key })
            if (isNil(property)) {
                continue
            }
            if (property.type === PropertyType.DYNAMIC) {
                const dynamicSchema = await resolveDynamicSchema({
                    key,
                    property,
                    value,
                    storedSchema: getOwn({ record: propertySettings, key })?.schema,
                    resolvedInput,
                    propertyContext,
                })
                if (!isNil(dynamicSchema)) {
                    const { processedInput: itemProcessedInput, errors: itemErrors } = await propsProcessor.applyProcessorsAndValidators({
                        resolvedInput: value,
                        props: dynamicSchema,
                        auth: undefined,
                        requireAuth: false,
                        propertySettings: {},
                    })
                    processedInput[key] = itemProcessedInput
                    if (Object.keys(itemErrors).length > 0) {
                        errors[key] = itemErrors
                    }
                }
            }
            if (property.type === PropertyType.ARRAY && property.properties) {
                const arrayOfObjects = arrayZipperProcessor(property, value) ?? []
                const processedArray = []
                const processedErrors = []
                for (const item of arrayOfObjects) {
                    const { processedInput: itemProcessedInput, errors: itemErrors } = await propsProcessor.applyProcessorsAndValidators({
                        resolvedInput: item,
                        props: property.properties,
                        auth: undefined,
                        requireAuth: false,
                        propertySettings: {},
                    })
                    processedArray.push(itemProcessedInput)
                    processedErrors.push(itemErrors)
                }
                processedInput[key] = processedArray
                const isThereErrors = processedErrors.some(error => Object.keys(error).length > 0)
                if (isThereErrors) {
                    errors[key] = {
                        properties: processedErrors,
                    }
                }
            }
            const processor = processors[property.type]
            if (processor) {
                const { data: processedValue, error: processorError } = await tryCatch(async () => processor(property, processedInput[key]))
                if (processorError instanceof PropertyProcessingError) {
                    processedInput[key] = null
                    processingErrors.set(key, [processorError.message])
                }
                else if (!isNil(processorError)) {
                    throw processorError
                }
                else {
                    processedInput[key] = processedValue
                }
            }
        }

        for (const [key, value] of Object.entries(processedInput)) {
            const property = getOwn({ record: props, key })
            if (isNil(property)) {
                continue
            }
            const processingError = processingErrors.get(key)
            if (!isNil(processingError)) {
                errors[key] = processingError
                continue
            }

            const validationErrors = validateProperty(property, value, resolvedInput[key])
            if (validationErrors.length > 0) {
                errors[key] = validationErrors
            }
        }

        return { processedInput, errors }
    },
}

// A stored schema is what the builder wrote when the user filled the form, so it wins. Flows
// written without the builder (MCP tools, REST, imports, the engine's own AI tools) carry none,
// and their sub-fields used to reach the qadam unprocessed — a FILE as its raw URL string (#388).
// Those get the schema the builder would have fetched, computed from the same `props()`.
async function resolveDynamicSchema({ key, property, value, storedSchema, resolvedInput, propertyContext }: ResolveDynamicSchemaParams): Promise<InputPropertyMap | undefined> {
    if (!isNil(storedSchema)) {
        return storedSchema
    }
    if (isNil(propertyContext) || !isObject(value)) {
        return undefined
    }
    const { data: schema, error } = await tryCatch(() => property.props(resolvedInput, propertyContext))
    if (error instanceof ExecutionError && error.type === ExecutionErrorType.ENGINE) {
        // Same contract as executeProps' tryCatchAndThrowOnEngineError: an engine bug must page.
        throw error
    }
    if (!isNil(error)) {
        // Not a step failure: `props()` often calls the third-party API, and before #388 nothing
        // at run time depended on it succeeding. Marker-first so the engine redacts the error
        // payload, which can carry request config (#403).
        console.error(`[Engine#resolveDynamicSchema] Could not compute the sub-fields of "${key}"; passing its value through unprocessed:`, error)
        return undefined
    }
    return schema ?? undefined
}

// Keys come from the step's input — user data — so a bare index would resolve `constructor`,
// `toString` or `__proto__` off Object.prototype and treat it as a declared property.
function getOwn<T>({ record, key }: { record: Record<string, T>, key: string }): T | undefined {
    return Object.hasOwn(record, key) ? record[key] : undefined
}

const validateProperty = (property: QadamProperty, value: unknown, originalValue: unknown): string[] => {
    if (property.type === PropertyType.JSON) {
        if (!property.required && originalValue === '') {
            return []
        }
        if (!isNil(originalValue) && isNil(value)) {
            return [`Expected JSON, received: ${originalValue}`]
        }
        if (!property.required && isNil(value)) {
            return []
        }
        if (!isObject(value) && !Array.isArray(value)) {
            return [`Expected JSON, received: ${originalValue}`]
        }
        return []
    }

    if (!property.required && isNil(value)) {
        return []
    }

    switch (property.type) {
        case PropertyType.SHORT_TEXT:
        case PropertyType.LONG_TEXT:
            return typeof value === 'string' ? [] : [`Expected string, received: ${originalValue}`]
        case PropertyType.NUMBER:
            return typeof value === 'number' && !Number.isNaN(value) ? [] : [`Expected number, received: ${originalValue}`]
        case PropertyType.CHECKBOX:
            return typeof value === 'boolean' ? [] : [`Expected boolean, received: ${originalValue}`]
        case PropertyType.DATE_TIME:
            return typeof value === 'string' ? [] : [`Invalid datetime format. Expected ISO format (e.g. 2024-03-14T12:00:00.000Z), received: ${originalValue}`]
        case PropertyType.ARRAY:
            return Array.isArray(value) ? [] : [`Expected array, received: ${originalValue}`]
        case PropertyType.OBJECT:
            return isObject(value) ? [] : [`Expected object, received: ${originalValue}`]
        case PropertyType.FILE:
            return isObject(value) ? [] : [`Expected a file as ${FILE_VALUE_FORMS}, received: ${originalValue}`]
        default:
            return []
    }
}

function getAuthPropsToProcess(authValue: AppConnectionValue, auth: QadamAuthProperty | QadamAuthProperty[] | undefined): | null {
    if (isNil(auth)) {
        return null
    }
    const usedAuthProperty = getAuthPropertyForValue({
        authValueType: authValue.type,
        qadamAuth: auth,
    })
    const doesAuthHaveProps = usedAuthProperty?.type === PropertyType.CUSTOM_AUTH || usedAuthProperty?.type === PropertyType.OAUTH2
    if (doesAuthHaveProps && !isNil(usedAuthProperty?.props)) {
        return usedAuthProperty.props
    }
    return null
}

type ApplyProcessorsAndValidatorsParams = {
    resolvedInput: StaticPropsValue<QadamPropertyMap>
    props: InputPropertyMap
    auth: QadamAuthProperty | QadamAuthProperty[] | undefined
    requireAuth: boolean
    propertySettings: Record<string, PropertySettings>
    /**
     * Lets a DYNAMIC property with no stored schema compute one through its own `props()`.
     * Omitted for nested calls: sub-fields are never DYNAMIC themselves.
     */
    propertyContext?: PropertyContext
}

type ResolveDynamicSchemaParams = {
    key: string
    property: DynamicProperties<boolean, QadamAuthProperty | QadamAuthProperty[] | undefined>
    value: unknown
    storedSchema: InputPropertyMap | undefined
    resolvedInput: StaticPropsValue<QadamPropertyMap>
    propertyContext: PropertyContext | undefined
}

type PropsValidationError = {
    [key: string]: string[] | PropsValidationError | PropsValidationError[]
}
