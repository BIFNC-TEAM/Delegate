# Open-Meteo weather MCP

Delegate's demo workspace publishes two read-only tools from the public
Streamable HTTP endpoint at `https://open-meteo.caseyjhand.com/mcp`:

- `openmeteo_search_locations`
- `openmeteo_get_forecast`

The binding is intentionally narrow. Historical, climate, marine, air-quality,
flood, ensemble, elevation, and DataCanvas SQL tools are not granted to the
representative.

## Trust boundary

Both tools are pinned by exact endpoint, transport, and Tool Schema hash in the
server-owned MCP policy registry. Remote descriptions, JSON Schema annotations,
and MCP annotations remain untrusted discovery data and cannot change effect,
approval, authority, or success semantics. Calls remain subject to the normal
Delegate Plan, policy, entitlement, lease, Verified Result, evidence, delivery,
and audit boundaries.

The hosted endpoint is maintained by the MCP server project, has no service
level agreement, and uses Open-Meteo data. Open-Meteo's keyless hosted API is
free for non-commercial use with attribution and fair-use limits. This seeded
binding is therefore for local development and non-commercial demonstration.
Production or monetized use must self-host the upstream services or use an
appropriately licensed commercial weather provider before enabling the binding.

## Current conversation limitation

The remote forecast tool requires latitude and longitude. The location-search
tool accepts a city name, but the current V3 Action Materializer does not yet
resolve one Action's output into the concrete arguments of a later MCP Action.
Consequently:

- a coordinate-based weather request can call the forecast tool directly;
- a city-name request can resolve the city and coordinates first;
- completing city lookup and forecast in one turn requires a future, generic
  previous-Action-output argument resolver or a trusted one-call weather tool.

Do not add a weather-specific prompt shortcut that bypasses the immutable Plan
or argument-provenance rules.

## Refresh and drift

The Compute Broker performs `tools/list` at startup and on its regular catalog
refresh interval. If either selected Tool Schema changes, publication becomes
unavailable and execution fails closed until the server-owned schema pin is
reviewed and updated.
