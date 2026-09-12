import { QadamPropertyMap, QadamProperty } from ".";
import { QadamAuthProperty } from "./authentication";
import { PropertyType } from "./input/property-type";
import { z } from "zod";
import { AUTHENTICATION_PROPERTY_NAME, formErrors, isEmpty, isNil } from "@aiqadam/shared";

function buildSchema(props: QadamPropertyMap, auth: QadamAuthProperty | QadamAuthProperty[] | undefined, requireAuth: boolean | undefined = true) {
    const entries = Object.entries(props);
    const propsSchema: Record<string, z.ZodType> = {};
    for (const [name, property] of entries) {
      switch (property.type) {
        case PropertyType.MARKDOWN:
          propsSchema[name] = z.union([z.null(), z.undefined(), z.never(), z.unknown()]).optional();
          break;
        case PropertyType.DATE_TIME:
        case PropertyType.SHORT_TEXT:
        case PropertyType.LONG_TEXT:
        case PropertyType.COLOR:
        case PropertyType.FILE:
          propsSchema[name] = property.required
            ? z.string().min(1)
            : z.string();
          break;
        case PropertyType.CHECKBOX:
          propsSchema[name] = z.union([
            z.boolean(),
            z.string(),
          ]);
          break;
        case PropertyType.NUMBER:
          propsSchema[name] = z.union([
            property.required ? z.string().min(1) : z.string(),
            z.number(),
          ]);
          break;
        case PropertyType.STATIC_DROPDOWN:
          propsSchema[name] = staticDropdownSchema(property);
          break;
        case PropertyType.DROPDOWN:
          propsSchema[name] = definedValueSchema();
          break;
        case PropertyType.SECRET_TEXT:
          propsSchema[name] = property.required
            ? z.string().min(1)
            : z.string();
          break;
        case PropertyType.BASIC_AUTH:
        case PropertyType.CUSTOM_AUTH:
        case PropertyType.OAUTH2:
          break;
        case PropertyType.ARRAY: {
          const arrayItemSchema = isNil(property.properties)
            ? (property.required ? z.string().min(1) : z.string())
            : buildSchema(property.properties, undefined);
          propsSchema[name] = z.union([
            property.required
              ? z.array(arrayItemSchema).min(1)
              : z.array(arrayItemSchema),
            //for inline items mode
            z.record(z.string(), z.unknown()),
            //for normal dynamic input mode
            property.required ? z.string().min(1) : z.string(),
          ]);
          break;
        }
        case PropertyType.OBJECT:
          propsSchema[name] = z.union([
            z.record(z.string(), z.any()),
            property.required ? z.string().min(1) : z.string(),
          ]);
          break;
        case PropertyType.JSON:
          propsSchema[name] = z.union([
            z.record(z.string(), z.any()),
            z.array(z.any()),
            property.required ? z.string().min(1) : z.string(),
          ]);
          break;
        case PropertyType.MULTI_SELECT_DROPDOWN:
        case PropertyType.STATIC_MULTI_SELECT_DROPDOWN:
          propsSchema[name] = z.union([
            property.required
              ? z.array(z.any()).min(1)
              : z.array(z.any()),
            property.required ? z.string().min(1) : z.string(),
          ]);
          break;
        case PropertyType.DYNAMIC:
          propsSchema[name] = z.record(z.string(), z.any());
          break;
        case PropertyType.CUSTOM:
          propsSchema[name] = z.unknown();
          break;
      }

      //optional array is checked against its children
      if (!property.required && property.type !== PropertyType.ARRAY) {
        propsSchema[name] = z.union(
          isEmpty(propsSchema[name])
            ? [z.any(), z.null(), z.undefined()] as [z.ZodType, z.ZodType, z.ZodType]
            : [propsSchema[name], z.null(), z.undefined()] as [z.ZodType, z.ZodType, z.ZodType],
        ).optional();
      }
    }
    if(auth && requireAuth)
      {
       propsSchema[AUTHENTICATION_PROPERTY_NAME] = z.string().min(1)
      }
    return z.object(propsSchema);
  }

function definedValueSchema() {
  return z.unknown().refine(
    (val) => val !== null && val !== undefined,
    { message: 'Value must not be null or undefined' },
  );
}

// A `StaticDropdown` declares its whole option set up front, so a value outside that set is an
// author error the server can catch — which is the point of #366. Two cases must still pass, or
// the check would reject configurations the product supports:
//
//   - a template expression (`{{ ... }}`), which is what the prop holds once the author switches it
//     to dynamic mode and is only resolvable at run time;
//   - an empty declared option list, which is what a `DynamicProperties` child carries in the
//     builder (`removeOptionsFromDropdownPropertiesSchema` strips options before rebuilding the
//     form schema) and what a disabled dropdown carries generally.
//
// `Dropdown` is deliberately left on the non-null check: its options are produced by a function at
// run time, so there is no declared set to compare against here.
function staticDropdownSchema(property: QadamProperty) {
  const declaredValues = readDeclaredOptionValues(property);
  if (declaredValues.length === 0) {
    return definedValueSchema();
  }
  return definedValueSchema().refine(
    (val) => isDynamicExpression(val) || declaredValues.some((declared) => valuesMatch(declared, val)),
    { message: formErrors.valueNotInOptions },
  );
}

function readDeclaredOptionValues(property: QadamProperty): unknown[] {
  const options = 'options' in property ? property.options : undefined;
  if (isNil(options) || typeof options !== 'object') {
    return [];
  }
  const entries = (options as { options?: unknown }).options;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => (entry as { value?: unknown })?.value);
}

function isDynamicExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}

// Stored step input travels through JSON and through form state, so a value that is semantically
// the declared option can differ from it in type (`1` vs `"1"`) or in key order. Comparing loosely
// keeps the check from failing flows that were valid before it existed; it costs only the ability
// to distinguish a number option from its own string spelling, which no dropdown relies on.
function valuesMatch(declared: unknown, value: unknown): boolean {
  if (declared === value) {
    return true;
  }
  if (isNil(declared) || isNil(value)) {
    return false;
  }
  if (typeof declared === 'object' || typeof value === 'object') {
    return canonicalize(declared) === canonicalize(value);
  }
  return String(declared) === String(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

  export const piecePropertiesUtils = {
    buildSchema
  }
