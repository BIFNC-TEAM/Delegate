export const connectorId = "delegate-tencent-sms-cn";

// Logto stores calling codes without '+'. Never accept an unqualified local
// number or silently reinterpret another country's number as a Chinese number.
export function mainlandMobileNumber(value) {
  if (typeof value !== "string" || !/^\+?861[3-9]\d{9}$/u.test(value)) {
    throw new Error("Only mainland China +86 mobile numbers are supported.");
  }
  return value.startsWith("+") ? value : `+${value}`;
}

export function withMainlandRecipients(sendMessage, invalidRecipient) {
  return async (data, config) => {
    let to;
    try {
      to = mainlandMobileNumber(data.to);
    } catch {
      throw invalidRecipient();
    }
    // Keep OTP creation, expiry, retries and single-use enforcement in Logto.
    return sendMessage({ ...data, to }, config);
  };
}
