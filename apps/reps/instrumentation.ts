import { preflightWeChatPayRuntime } from "@delegate/web-data";

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const preflight = preflightWeChatPayRuntime();
  if (!preflight.ready) {
    const errorCode =
      preflight.errorCode
      ?? "wechat_pay_configuration_invalid";
    console.error(
      "reps startup preflight failed:",
      errorCode,
    );
    throw new Error(errorCode);
  }
}
