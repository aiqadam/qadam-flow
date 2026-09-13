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
//
// Both option sets are built once, when the schema is built, and the submitted value is turned into
// a comparable form at most once per parse. Comparing it against each option in turn instead would
// re-serialise the whole submitted value per option — with the 419-option `timezone` dropdown of
// `@aiqadam/qadam-schedule` and a multi-megabyte value, that is seconds of non-yielding work on the
// API's single thread, reachable by anyone who may edit a flow.
function staticDropdownSchema(property: QadamProperty) {
  const declaredValues = readDeclaredOptionValues(property);
  if (declaredValues.length === 0) {
    return definedValueSchema();
  }
  // A prop's own `defaultValue` has to be acceptable even when it is absent from the prop's option
  // list, or the check would contradict the declaration it is checking. Several shipped qadams are
  // in exactly that state — `@aiqadam/qadam-nocodb`'s `version` defaults to `0` against options
  // `1..4`, `@aiqadam/qadam-clickup`'s channel `visibility` defaults to `'public'` against
  // `'PUBLIC'`/`'PRIVATE'` — and the builder seeds every form from `defaultValue`, so without this
  // a NocoDB connection could not be created at all and existing ClickUp steps would flip invalid.
  // Correcting those declarations, and scanning for the ones nobody has found yet, is #427; this
  // accommodation stays either way, since a qadam is free to ship a default the list omits.
  const acceptedValues = 'defaultValue' in property && !isNil(property.defaultValue)
    ? [...declaredValues, property.defaultValue]
    : declaredValues;
  const primitiveOptions = new Set(
    acceptedValues.filter((declared) => !isObjectLike(declared)).map((declared) => String(declared)),
  );
  const objectOptions = new Set(
    acceptedValues.filter(isObjectLike).map((declared) => canonicalize({ value: declared, depth: 0 })),
  );
  return definedValueSchema().refine(
    (val) => matchesDeclaredOption({ value: val, primitiveOptions, objectOptions }),
    { message: formErrors.valueNotInOptions },
  );
}

// Stored step input travels through JSON and through form state, so a value that is semantically
// the declared option can differ from it in type (`1` vs `"1"`) or in key order. Comparing loosely
// keeps the check from failing flows that were valid before it existed; it costs only the ability
// to distinguish a number option from its own string spelling, which no dropdown relies on.
function matchesDeclaredOption({ value, primitiveOptions, objectOptions }: {
  value: unknown
  primitiveOptions: Set<string>
  objectOptions: Set<string>
}): boolean {
  // An unset value is not a wrong one. `null`/`undefined` is already reported by the defined-value
  // check, and `''` is what the builder puts in a dropdown the author has just toggled into
  // dynamic-input mode (`getDefaultPropertyValue`) — rejecting it would make the field invalid
  // until a whole expression has been typed, which it never was before this check existed.
  if (isNil(value) || value === '' || isDynamicExpression(value)) {
    return true;
  }
  if (!isObjectLike(value)) {
    return primitiveOptions.has(String(value));
  }
  // No object option can be matched by anything, so a hostile array or deep object is rejected
  // without being walked at all — which is the common case, since almost every dropdown in the
  // repo declares primitive option values.
  if (objectOptions.size === 0) {
    return false;
  }
  const canonicalValue = canonicalize({ value, depth: 0 });
  return canonicalValue !== TOO_DEEP && objectOptions.has(canonicalValue);
}

function readDeclaredOptionValues(property: QadamProperty): unknown[] {
  const options = 'options' in property ? property.options : undefined;
  if (!isObjectOrArray(options)) {
    return [];
  }
  const entries = options.options;
  if (!Array.isArray(entries)) {
    return [];
  }
  // A malformed entry contributes nothing rather than an `undefined` that would land in the
  // accepted set as the literal string "undefined".
  return entries.filter(isObjectOrArray).map((entry) => entry.value);
}

function isObjectOrArray(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDynamicExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}

function isObjectLike(value: unknown): boolean {
  return isObjectOrArray(value);
}

// Recursion over a value the caller controls needs a floor. Without this cap, a nested array
// overflows the stack here — reproduced on Node 26 at 20k, 60k and 400k levels — and zod re-throws
// whatever a refinement throws rather than turning it into a validation failure, so it would
// surface as a 500 on flow update rather than a rejected value. A value deeper than any real
// dropdown option cannot be one, so a sentinel that matches nothing is both cheap and correct.
function canonicalize({ value, depth }: { value: unknown, depth: number }): string {
  if (depth > MAX_OPTION_DEPTH) {
    return TOO_DEEP;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize({ value: entry, depth: depth + 1 })).join(',')}]`;
  }
  if (isObjectOrArray(value)) {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize({ value: entryValue, depth: depth + 1 })}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const MAX_OPTION_DEPTH = 32;
const TOO_DEEP = ' too-deep';

  export const piecePropertiesUtils = {
    buildSchema
  }
