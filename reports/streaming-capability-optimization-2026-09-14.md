# Public capability-response streaming optimization

Date: 2026-09-14
Route: `/reps/founder-representative-2?lang=zh`
Model: `qwen-plus`

This is a targeted comparison for the reported capability question. It is not
the deferred full 90-case performance comparison.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Model calls | 3 | 1 | -66.67% |
| Tool calls | 1 | 0 | -1 unnecessary retrieval |
| First model text | 1253.549 ms | 1199.484 ms | -4.31% |
| Pi Agent total | 10921.737 ms | 4169.104 ms | -61.83% |
| Worker wall time | 11007 ms | 4336 ms | -60.61% |
| Stream/terminal consistency | superseded draft was concatenated | exact match | fixed |

Before run: `cmu0vlsxa05twpa0n40n8lwbv`
After run: `cmu0wg0270077ul0nbtthi43f`

Browser verification used the semantically equivalent prompt “请简短介绍你能提供哪些帮助？”.
The first valid answer text appeared at 1851 ms, the terminal answer was visible
at 3901 ms, and 13 distinct answer states were rendered at roughly 150–200 ms
intervals. Run: `cmu0wixf200bgul0nwbtsxt3f`.

The waiting copy is not counted as answer text. The final persisted stream and
terminal message were identical. Evidence screenshot:
`reports/streaming-capability-after.png`.

Representative-domain facts and organization-specific questions still require
the evidence path. When representative-domain retrieval returns no source, the
runtime now returns a deterministic knowledge limitation instead of publishing
an invented publication, textbook, or authority.
