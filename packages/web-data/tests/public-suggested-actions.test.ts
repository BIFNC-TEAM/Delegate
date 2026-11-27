import { expect, it } from "vitest";
import { readPublicSuggestedActions, suggestedActionsForError } from "../src/public-agent-presentation";
import { createV2PairedConversationHistory } from "../../model-runtime/src/v2/prompt";
it("maps only stable host errors and ignores unknown persisted actions", () => {
  expect(suggestedActionsForError("authentication_required")).toEqual([{ type: "login" }]);
  expect(suggestedActionsForError("用户没有登录")).toEqual([]);
  expect(readPublicSuggestedActions({ suggestedActions: [{ type: "execute", url: "bad" }, { type: "login", url: "bad" }] })).toEqual([{ type: "login" }]);
});
it("does not serialize additional fields when constructing model history", () => {
  const messages = [{ role: "user" as const, text: "咨询", timestamp: 1, content: { suggestedActions: [{ type: "login" }] } }];
  const history = createV2PairedConversationHistory(messages, {} as never);
  expect(JSON.stringify(history)).not.toContain("suggestedActions");
  expect(JSON.stringify(history)).not.toContain("login");
  expect(history[0]).toMatchObject({ content: "咨询" });
});
