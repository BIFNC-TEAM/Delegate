import { describe, expect, it } from "vitest";

import { resolveConversationWorkerConfig } from "../src/config";

describe("conversation worker config", () => {
  it("allows web-only processing without Matrix credentials", () => {
    expect(resolveConversationWorkerConfig({})).toMatchObject({ port: 4040, pollMs: 500 });
  });

  it("requires Matrix URL and application-service token together", () => {
    expect(() => resolveConversationWorkerConfig({ MATRIX_HOMESERVER_URL: "https://matrix.example" })).toThrow(
      "must be configured together",
    );
  });
});
