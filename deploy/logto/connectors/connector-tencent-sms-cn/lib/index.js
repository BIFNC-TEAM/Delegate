import { ConnectorError, ConnectorErrorCodes } from "@logto/connector-kit";
import createTencentSmsConnector from "../../@logto-connector-tencent-sms/lib/index.js";

import { connectorId, withMainlandRecipients } from "./phone.js";

// Loaded alongside the official connector in the pinned Logto 1.41.0 image.
export default async function createMainlandTencentSmsConnector({ getConfig }) {
  const upstream = await createTencentSmsConnector({ getConfig: () => getConfig(connectorId) });
  return {
    ...upstream,
    metadata: {
      ...upstream.metadata,
      id: connectorId,
      target: "delegate-tencent-sms-cn",
      name: { en: "Tencent SMS (+86 only)", "zh-CN": "腾讯云短信（仅中国大陆）" },
      logo: "../@logto-connector-tencent-sms/logo.svg",
      readme: "./README.md",
    },
    sendMessage: withMainlandRecipients(upstream.sendMessage, () => new ConnectorError(
      ConnectorErrorCodes.General,
      "Only mainland China +86 mobile numbers are supported.",
    )),
  };
}
