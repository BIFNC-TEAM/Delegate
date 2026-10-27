import { describe, expect, it } from "vitest";
import { validateDeclaredAttachmentRead } from "../src/attachment-inputs";

const attachment = {
  id: "attachment-1",
  fileName: "orders.csv",
  mimeType: "text/csv",
  uri: "/workspace/inputs/orders.csv",
};

describe("authorized attachment read guards", () => {
  it("requires a selected attachment and an actual file-read expression", () => {
    expect(validateDeclaredAttachmentRead({
      code: "print('rows,10000')",
      attachmentIds: [],
      attachments: [attachment],
    })).toEqual({ ok: false, reason: "sandbox_attachment_selection_missing" });
    expect(validateDeclaredAttachmentRead({
      code: "# /workspace/inputs/orders.csv\nprint('rows,10000')",
      attachmentIds: ["orders.csv"],
      attachments: [attachment],
    })).toEqual({ ok: false, reason: "sandbox_attachment_path_not_read" });
    expect(validateDeclaredAttachmentRead({
      code: "INPUT_PATH = '/workspace/inputs/orders.csv'\nwith open(INPUT_PATH) as source:\n    source.read()",
      attachmentIds: ["attachment-1"],
      attachments: [attachment],
    })).toEqual({ ok: true });
  });

  it("validates reads against the declared sandbox URI rather than the display name", () => {
    expect(validateDeclaredAttachmentRead({
      code: "with open('/workspace/inputs/attachment-safe.md') as source:\n    print(source.read())",
      attachmentIds: ["attachment-unicode"],
      attachments: [{
        id: "attachment-unicode",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        uri: "/workspace/inputs/attachment-safe.md",
      }],
    })).toEqual({ ok: true });
  });

});
