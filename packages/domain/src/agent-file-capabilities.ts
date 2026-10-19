/** Current Pi stdout delivery contract; browser screenshots are separate. */
export const agentTextFileOutput = {
  version: "delegate.agent-text-file.v1",
  maximumFiles: 1,
  maximumBytes: 65_536,
  formats: {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
  },
} as const;

export const agentTextFileOutputNotice = {
  zh: "通过运行环境预检后，单次智能体代码调用的产物契约支持 1 个 UTF-8 文本、Markdown、CSV 或 JSON 文件，最大 64 KiB。格式支持不代表当前环境已经可以执行代码。暂不支持生成 PDF、Excel 等二进制结果，或一次执行收集多个输出文件；浏览器截图单独提供。此限制针对结果交付，不代表不能读取相应输入附件。",
  en: "After runtime preflight is satisfied, each Agent code call supports one UTF-8 TXT, Markdown, CSV or JSON output file, up to 64 KiB. Format support does not mean code execution is currently available. Generating binary results such as PDF, Excel or images, and collecting multiple output files from one execution, are not supported yet. Browser screenshots are separate. These limits concern output delivery, not whether an input attachment can be read.",
} as const;
