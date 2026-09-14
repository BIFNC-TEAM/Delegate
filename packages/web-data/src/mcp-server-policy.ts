export type McpSuccessContract = Record<string, unknown>;

export type McpCapabilitySemantics = {
  operations: string[];
  evidenceClasses: string[];
  freshnessClasses: string[];
  authorityClasses: string[];
  domains: string[];
  aliases: string[];
};

export type CapabilityServerPolicy = {
  policyId: string;
  classificationVersion: string;
  effect: {
    boundary: "external";
    mutation: "none" | "write";
    reversibility: "not_applicable" | "reversible" | "irreversible" | "unknown";
  };
  idempotency: "naturally_idempotent" | "idempotency_key" | "not_idempotent" | "unknown";
  successContract?: McpSuccessContract;
  semantics?: McpCapabilitySemantics;
  supportedChannels?: string[];
  requiredIdentityScopes?: string[];
  requiredDataScopes?: string[];
  argumentDefaults?: Record<string, unknown>;
};

export function resolveServerOwnedMcpCapabilityPolicy(input: {
  serverUrl: string;
  transportKind: string;
  toolName: string;
  toolSchemaHash: string;
  inputSchema?: Record<string, unknown>;
}): CapabilityServerPolicy | null {
  const endpoint = normalizeTrustedMcpEndpoint(input.serverUrl);
  const transportKind = input.transportKind.trim().toLowerCase();
  const toolName = input.toolName.trim().toLowerCase();
  const toolSchemaHash = stripSha256(input.toolSchemaHash);
  const expectedSchemaHash = DEEPWIKI_TRUSTED_TOOL_SCHEMA_HASHES[toolName];
  if (
    endpoint === DEEPWIKI_TRUSTED_ENDPOINT
    && transportKind === "streamable_http"
    && typeof expectedSchemaHash === "string"
    && toolSchemaHash === expectedSchemaHash
  ) {
    return {
      policyId: "delegate.mcp-policy.deepwiki.public-read.v1",
      classificationVersion: "delegate.mcp-effect.deepwiki.v2",
      effect: {
        boundary: "external",
        mutation: "none",
        reversibility: "not_applicable",
      },
      idempotency: "naturally_idempotent",
      successContract: {
        kind: "server_evaluator",
        evaluatorId: "mcp.deepwiki.read_semantic",
        evaluatorVersion: "2",
      },
    };
  }
  const openMeteoPolicy = OPEN_METEO_TRUSTED_TOOL_POLICIES[toolName];
  if (
    endpoint === OPEN_METEO_TRUSTED_ENDPOINT
    && transportKind === "streamable_http"
    && openMeteoPolicy
    && (
      toolSchemaHash === openMeteoPolicy.schemaHash
      || matchesMinimumReadOnlyInputContract(
        input.inputSchema,
        openMeteoPolicy.minimumInputContract,
      )
    )
  ) {
    return {
      policyId: "delegate.mcp.openmeteo.read.v1",
      classificationVersion: "delegate.mcp.openmeteo.effect.v1",
      effect: {
        boundary: "external",
        mutation: "none",
        reversibility: "not_applicable",
      },
      idempotency: "naturally_idempotent",
      successContract: openMeteoPolicy.successContract,
      semantics: openMeteoPolicy.semantics,
      ...(openMeteoPolicy.argumentDefaults
        ? { argumentDefaults: openMeteoPolicy.argumentDefaults }
        : {}),
    };
  }
  return null;
}

const DEEPWIKI_TRUSTED_ENDPOINT = "https://mcp.deepwiki.com/mcp";
const DEEPWIKI_TRUSTED_TOOL_SCHEMA_HASHES: Readonly<Record<string, string>> = {
  ask_question:
    "5f937ca02cb792c59d6f31b22d1e09db2a6412ee27b8e180a04c0bb38a24cd24",
  read_wiki_contents:
    "3fc0be2454d2c65d3ff7a7be36bb9fb4903931cbb9bfac6042696d0caf42cb00",
  read_wiki_structure:
    "3fc0be2454d2c65d3ff7a7be36bb9fb4903931cbb9bfac6042696d0caf42cb00",
};

const OPEN_METEO_TRUSTED_ENDPOINT = "https://open-meteo.caseyjhand.com/mcp";
const OPEN_METEO_TRUSTED_TOOL_POLICIES: Readonly<Record<
  string,
  {
    schemaHash: string;
    successContract: McpSuccessContract;
    semantics: McpCapabilitySemantics;
    argumentDefaults?: Record<string, unknown>;
    minimumInputContract: Record<string, "string" | "number">;
  }
>> = {
  openmeteo_search_locations: {
    schemaHash:
      "af23eb22e1651a38e705d9ceeff31faca25ef327324256088ca275b8d2849968",
    minimumInputContract: { name: "string" },
    successContract: {
      kind: "success_schema",
      schema: {
        type: "object",
        properties: {
          results: { type: "array", items: {} },
          count: { type: "number" },
        },
        required: ["results", "count"],
      },
    },
    semantics: {
      operations: ["search"],
      evidenceClasses: ["capability_result", "current_external"],
      freshnessClasses: ["bounded", "live"],
      authorityClasses: ["external_authoritative"],
      domains: ["geocoding", "location", "weather"],
      aliases: [
        "location search",
        "place coordinates",
        "city coordinates",
        "地点搜索",
        "城市坐标",
      ],
    },
  },
  openmeteo_get_forecast: {
    schemaHash:
      "2840c6995fddbdcfcc96c3548add6fe4fa75aa44e0768368d41a05ba826c0af0",
    minimumInputContract: { latitude: "number", longitude: "number" },
    successContract: {
      kind: "success_schema",
      schema: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          timezone: { type: "string" },
          record_count: { type: "number" },
          truncated: { type: "boolean" },
        },
        required: [
          "latitude",
          "longitude",
          "timezone",
          "record_count",
          "truncated",
        ],
      },
    },
    semantics: {
      operations: ["read", "search"],
      evidenceClasses: ["capability_result", "current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
      domains: ["weather", "weather forecast", "meteorology"],
      aliases: [
        "forecast",
        "current weather",
        "temperature",
        "precipitation",
        "天气",
        "天气预报",
        "气温",
        "降雨",
      ],
    },
    argumentDefaults: {
      hourly_variables: [
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "precipitation_probability",
        "weather_code",
        "wind_speed_10m",
      ],
    },
  },
};

function matchesMinimumReadOnlyInputContract(
  schema: Record<string, unknown> | undefined,
  contract: Record<string, "string" | "number">,
) {
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false) {
    return false;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.entries(contract).every(([name, type]) => {
    const property = properties[name];
    if (!required.has(name) || !isRecord(property)) return false;
    return property.type === type
      || (Array.isArray(property.type) && property.type.includes(type));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function normalizeTrustedMcpEndpoint(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return null;
    const pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `${url.origin.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

function stripSha256(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
