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
Delegate Plan, capability policy, approval, lease, Verified Result, evidence,
delivery, and audit boundaries. MCP-only answers do not require a Pass and do
not reserve, consume, or increment conversation service usage; a mixed MCP +
non-MCP task keeps the ordinary billing contract of its non-MCP work.

The hosted endpoint is maintained by the MCP server project, has no service
level agreement, and uses Open-Meteo data. Open-Meteo's keyless hosted API is
free for non-commercial use with attribution and fair-use limits. This seeded
binding is therefore for local development and non-commercial demonstration.
Production or monetized use must self-host the upstream services or use an
appropriately licensed commercial weather provider before enabling the binding.

## Multi-action execution

City-name requests use the generic V3 dependency protocol rather than a
weather-specific router:

1. the location tool receives the grounded place name;
2. its successful, schema-verified `ActionResult` supplies latitude,
   longitude, and timezone through `previous_action_output` provenance;
3. the forecast step resolves those pointers under the current Plan/Action
   fence, validates the final arguments against the pinned input Schema, and
   only then enters ordinary Policy, Approval, Lease, and MCP execution;
4. the Composer reads only verified ActionResults.

The forecast capability also publishes a reviewed server-owned default set of
hourly weather variables. The generic materializer records those values as
`capability_default` provenance bound to the immutable capability definition;
remote MCP descriptions and annotations cannot create or change defaults.

Missing, ambiguous, failed, or schema-incompatible dependency output fails
closed. It is never replaced by a model-invented coordinate or weather fact.

## Refresh and drift

The Compute Broker performs `tools/list` at startup and on its regular catalog
refresh interval. If either selected Tool Schema changes, publication becomes
unavailable and execution fails closed until the server-owned schema pin is
reviewed and updated.
