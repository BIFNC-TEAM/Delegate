const MAX_WECHAT_NOTIFICATION_BYTES = 1_100_000;

/**
 * Reads the exact callback bytes while enforcing a hard upper bound. Signature
 * verification must never receive a parsed and reserialized JSON body.
 */
export async function readBoundedWeChatNotificationBody(
  request: Request,
): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_WECHAT_NOTIFICATION_BYTES
  ) {
    return null;
  }
  if (!request.body) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_WECHAT_NOTIFICATION_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) {
    return null;
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    byteLength,
  ).toString("utf8");
}

export function readWeChatPaySignatureHeaders(
  headers: Headers,
): Record<string, string | undefined> {
  return {
    "Wechatpay-Timestamp":
      headers.get("Wechatpay-Timestamp") ?? undefined,
    "Wechatpay-Nonce": headers.get("Wechatpay-Nonce") ?? undefined,
    "Wechatpay-Serial": headers.get("Wechatpay-Serial") ?? undefined,
    "Wechatpay-Signature":
      headers.get("Wechatpay-Signature") ?? undefined,
    "Wechatpay-Signature-Type":
      headers.get("Wechatpay-Signature-Type") ?? undefined,
  };
}
