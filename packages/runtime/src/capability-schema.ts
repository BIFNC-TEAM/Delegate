import sha256 from "fast-sha256";

export function assertSupportedCapabilitySchema(
  schema: Record<string, unknown>,
  label: string,
  requireClosedRoot: boolean,
) {
  const visit = (
    current: Record<string, unknown>,
    path: string,
    closedObject: boolean,
  ) => {
    for (const key of Object.keys(current)) {
      if (!isSupportedJsonSchemaKeyword(key)) {
        throw new Error(
          `Capability ${label} schema uses unsupported keyword ${key} at ${path}.`,
        );
      }
    }
    const type = current.type;
    if (
      typeof type !== "undefined"
      && ![
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
      ].includes(String(type))
    ) {
      throw new Error(
        `Capability ${label} schema has unsupported type at ${path}.`,
      );
    }
    if (type === "object") {
      if (closedObject && current.additionalProperties !== false) {
        throw new Error(
          `Capability ${label} object schema must set additionalProperties=false at ${path}.`,
        );
      }
      const properties = isRecord(current.properties)
        ? current.properties
        : {};
      const required = Array.isArray(current.required) ? current.required : [];
      if (!required.every((item) => typeof item === "string" && item in properties)) {
        throw new Error(
          `Capability ${label} schema has an invalid required property at ${path}.`,
        );
      }
      for (const [key, nested] of Object.entries(properties)) {
        if (!isRecord(nested)) {
          throw new Error(
            `Capability ${label} property ${key} has no schema at ${path}.`,
          );
        }
        visit(
          nested,
          `${path}/properties/${escapeJsonPointer(key)}`,
          closedObject,
        );
      }
    }
    if (type === "array") {
      if (!isRecord(current.items)) {
        throw new Error(
          `Capability ${label} array schema has no item schema at ${path}.`,
        );
      }
      visit(current.items, `${path}/items`, closedObject);
    }
    for (const composition of ["allOf", "anyOf"] as const) {
      if (typeof current[composition] === "undefined") continue;
      if (
        !Array.isArray(current[composition])
        || !current[composition].every(isRecord)
      ) {
        throw new Error(
          `Capability ${label} schema has invalid ${composition} at ${path}.`,
        );
      }
      (current[composition] as Record<string, unknown>[]).forEach(
        (nested, index) => {
          visit(nested, `${path}/${composition}/${index}`, closedObject);
        },
      );
    }
  };
  if (requireClosedRoot && schema.type !== "object") {
    throw new Error(
      `Capability ${label} schema root must have type=object.`,
    );
  }
  visit(schema, "/", requireClosedRoot);
}

/**
 * Derives the bounded schema exposed to a model or executor without mutating
 * the exact schema persisted from the remote capability provider.
 */
export function deriveCapabilitySchema(
  schema: Record<string, unknown>,
  options: {
    closeObjects: boolean;
    dropUnsupportedOutputKeywords?: boolean;
  },
): Record<string, unknown> {
  const visit = (
    current: Record<string, unknown>,
    path: string,
  ): Record<string, unknown> => {
    const derived: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith("x-") || isNonValidationJsonSchemaAnnotation(key)) {
        continue;
      }
      if (key === "type" && Array.isArray(value)) {
        if (!options.dropUnsupportedOutputKeywords) {
          throw new Error(
            `Capability schema has unsupported union type at ${path}.`,
          );
        }
        const types = [...new Set(value.filter(isSupportedJsonSchemaType))];
        if (types.length === 1) derived.type = types[0];
        else if (types.length > 1) {
          derived.anyOf = types.map((type) => ({ type }));
        }
        continue;
      }
      if (
        options.dropUnsupportedOutputKeywords
        && (isUnsupportedProjectedOutputKeyword(key)
          || !isSupportedJsonSchemaKeyword(key))
      ) {
        continue;
      }
      if (!isSupportedJsonSchemaKeyword(key)) {
        throw new Error(
          `Capability schema uses unsupported keyword ${key} at ${path}.`,
        );
      }
      if (key === "properties" && isRecord(value)) {
        derived[key] = Object.fromEntries(
          Object.entries(value).map(([property, nested]) => {
            if (!isRecord(nested)) {
              throw new Error(
                `Capability property ${property} has no schema at ${path}.`,
              );
            }
            return [
              property,
              visit(
                nested,
                `${path}/properties/${escapeJsonPointer(property)}`,
              ),
            ];
          }),
        );
        continue;
      }
      if (key === "items" && isRecord(value)) {
        derived[key] = visit(value, `${path}/items`);
        continue;
      }
      if ((key === "allOf" || key === "anyOf") && Array.isArray(value)) {
        if (!value.every(isRecord)) {
          throw new Error(
            `Capability schema has invalid ${key} at ${path}.`,
          );
        }
        derived[key] = value.map((nested, index) =>
          visit(nested, `${path}/${key}/${index}`));
        continue;
      }
      derived[key] = value;
    }
    if (options.closeObjects && derived.type === "object") {
      derived.additionalProperties = false;
    }
    return derived;
  };
  return visit(schema, "/");
}

export function stableSha256(value: unknown) {
  const digest = sha256(new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(
      ([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`,
    )
    .join(",")}}`;
}

function isNonValidationJsonSchemaAnnotation(key: string) {
  return [
    "$schema",
    "$id",
    "$comment",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ].includes(key);
}

function isUnsupportedProjectedOutputKeyword(key: string) {
  return key === "not" || key === "propertyNames" || key === "oneOf";
}

function isSupportedJsonSchemaType(value: unknown): value is string {
  return typeof value === "string" && [
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ].includes(value);
}

function isSupportedJsonSchemaKeyword(key: string) {
  return [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "default",
    "allOf",
    "anyOf",
    "title",
    "description",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ].includes(key);
}

function escapeJsonPointer(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
