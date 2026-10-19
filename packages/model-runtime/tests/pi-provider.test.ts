import { describe, expect, it, vi } from "vitest";

import { createObservedProviderFetch, createPiModelBindingFromEnv } from "../src/pi/provider";
import type { PiModelAttemptEvent } from "../src/pi/types";

describe("Pi provider attempt observation", () => {
  it("keeps provider capacity separate from retrieval budget and reserves useful output after a large page", async () => {
    const sent:number[]=[];
    for (const capacity of [undefined, '32768']) {
      const b=createPiModelBindingFromEnv({DELEGATE_MODEL_PROVIDER:'agicto',DELEGATE_AGICTO_API_KEY:'fixture',DELEGATE_AGICTO_BASE_URL:'https://fixture.invalid/v1',DELEGATE_AGICTO_MODEL:'fixture',DELEGATE_MODEL_MAX_INPUT_TOKENS:'2400',...(capacity?{DELEGATE_PI_CONTEXT_WINDOW_TOKENS:capacity}:{})});
      if(!b.ok)throw new Error('binding failed');
      const stream=await b.binding.streamFn(b.binding.model,{messages:[{role:'user',content:'x'.repeat(60000),timestamp:Date.now()}]}, {fetch:async(_url,init)=>{
        sent.push(JSON.parse(String(init?.body)).max_tokens);
        return new Response('data: '+JSON.stringify({id:'test',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      }});
      expect((await stream.result()).stopReason).toBe('stop');
    }
    expect(sent).toEqual([1,4096]);
  });
  it("records each physical HTTP attempt and whether Pi will retry it", async () => {
    const events: PiModelAttemptEvent[] = [];
    const baseFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const observed = createObservedProviderFetch({
      fetch: baseFetch,
      observer: (event) => events.push(event),
      logicalCallId: "turn-1",
      maximumRetries: 1,
      maximumRetryDelayMs: 2_000,
    });

    await observed("https://provider.test/v1/chat");
    await observed("https://provider.test/v1/chat");

    expect(events).toEqual([
      { type: "start", logicalCallId: "turn-1", attempt: 1 },
      { type: "end", logicalCallId: "turn-1", attempt: 1, status: "error", httpStatus: 503, willRetry: true },
      { type: "start", logicalCallId: "turn-1", attempt: 2 },
      { type: "end", logicalCallId: "turn-1", attempt: 2, status: "ok", httpStatus: 200 },
    ]);
  });

  it("does not report a retry when the provider delay exceeds the configured cap", async () => {
    const events: PiModelAttemptEvent[] = [];
    const observed = createObservedProviderFetch({
      fetch: vi.fn(async () => new Response("slow down", {
        status: 429,
        headers: { "retry-after-ms": "5000" },
      })),
      observer: (event) => events.push(event),
      logicalCallId: "turn-delay",
      maximumRetries: 1,
      maximumRetryDelayMs: 2_000,
    });

    await observed("https://provider.test/v1/chat");

    expect(events.at(-1)).toEqual({
      type: "end",
      logicalCallId: "turn-delay",
      attempt: 1,
      status: "error",
      httpStatus: 429,
    });
  });
});
