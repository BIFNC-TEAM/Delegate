import { describe, expect, it } from "vitest";

import { canonicalizeDelegationTaskEvent } from "../src/delegation-task-events";

describe("delegation task event canonicalization", () => {
  it("produces the same representation regardless of object key order", () => {
    const left = canonicalizeDelegationTaskEvent({
      payload: { artifactIds: ["a", "b"], outcome: "completed" },
      sequence: 4,
      actor: "system",
    });
    const right = canonicalizeDelegationTaskEvent({
      actor: "system",
      sequence: 4,
      payload: { outcome: "completed", artifactIds: ["a", "b"] },
    });
    expect(left).toBe(right);
  });

  it("preserves array order and omits undefined object fields", () => {
    expect(canonicalizeDelegationTaskEvent({ values: [2, 1], ignored: undefined }))
      .toBe('{"values":[2,1]}');
  });
});
