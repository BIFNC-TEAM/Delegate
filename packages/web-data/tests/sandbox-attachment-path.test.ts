import { describe, expect, it } from "vitest";

import {
  buildSandboxAttachmentFileName,
  buildSandboxAttachmentPath,
} from "../src/conversation-platform";

describe("sandbox attachment paths", () => {
  it("preserves the display extension while producing an ASCII-only provider path", () => {
    expect(buildSandboxAttachmentFileName("附件/../id:一", "欢迎 文档😊.MD"))
      .toBe("attachment-id.md");
    expect(buildSandboxAttachmentPath("attachment-123", "欢迎.md"))
      .toBe("/workspace/inputs/attachment-attachment-123.md");
  });

  it("uses a binary extension when the display name has no safe extension", () => {
    expect(buildSandboxAttachmentFileName("attachment-123", "欢迎"))
      .toBe("attachment-attachment-123.bin");
  });
});
