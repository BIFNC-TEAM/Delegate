import { describe, expect, it } from "vitest";

import {
  defaultTurnConstraints,
  deriveTurnConstraintsFromMessage,
} from "../src";

describe("turn-scoped constraints", () => {
  it("normalizes explicit tool policies without carrying them to the next message", () => {
    expect(deriveTurnConstraintsFromMessage(
      "请用三句话解释 CAP 定理，不要使用任何工具。",
    )).toMatchObject({
      scope: "turn",
      toolPolicy: "forbidden",
      source: "explicit_user_instruction",
      sourcePointers: ["/currentMessage/text"],
    });
    expect(deriveTurnConstraintsFromMessage(
      "请使用工具查询仓库，并说明信息来自工具结果。",
    ).toolPolicy).toBe("required");
    expect(deriveTurnConstraintsFromMessage(
      "不用任何工具，用三句中文说明 CAP 定理。",
    ).toolPolicy).toBe("forbidden");
    expect(deriveTurnConstraintsFromMessage(
      "无需调用外部工具，直接解释即可。",
    ).toolPolicy).toBe("forbidden");
    expect(deriveTurnConstraintsFromMessage(
      "无需调用任何外部工具，请直接解释。",
    ).toolPolicy).toBe("forbidden");
    expect(deriveTurnConstraintsFromMessage(
      "使用工具查询 openai/openai-python 的重试机制。",
    ).toolPolicy).toBe("required");
    expect(deriveTurnConstraintsFromMessage("下一轮正常回答即可。"))
      .toEqual(defaultTurnConstraints);
  });

  it("fails safe when one turn contains contradictory tool instructions", () => {
    expect(deriveTurnConstraintsFromMessage(
      "不要使用任何工具，但必须使用工具查询。",
    ).toolPolicy).toBe("conflict");
  });

  it("does not infer mandatory tool use from an ordinary lookup verb", () => {
    expect(deriveTurnConstraintsFromMessage(
      "查询 openai/openai-python 中 AsyncOpenAI 的重试机制。",
    ).toolPolicy).toBe("auto");
  });
});
