import { isIP } from "node:net";

import type { PricingPlan } from "@delegate/domain";

export type TelegramBotCommand = {
  command: string;
  description: string;
};

export function buildTelegramBotCommands(
  starsPurchasesEnabled: boolean,
  computeRunsInBot = true,
): TelegramBotCommand[] {
  return [
    { command: "start", description: "Introduce the representative" },
    { command: "plans", description: "Show service plans and continuation options" },
    {
      command: "buy",
      description: starsPurchasesEnabled
        ? "Buy Pass / Deep Help / Sponsor in Telegram Stars"
        : "Continue Pass / Deep Help / Sponsor on Web",
    },
    {
      command: "compute",
      description: computeRunsInBot
        ? "Run a governed compute request in the sandbox"
        : "Continue governed compute requests on Web",
    },
    { command: "bind", description: "Bind this Telegram account to your Delegate account" },
    { command: "memory_share", description: "Review and allow cross-channel Contact Memory" },
    { command: "memory_unshare", description: "Stop and delete cross-channel Contact Memory" },
    { command: "delete_memory", description: "Delete Contact Memory for this representative and channel" },
    { command: "forget", description: "Alias for deleting this channel's Contact Memory" },
    { command: "paysupport", description: "Get payment and refund support" },
  ];
}

export function buildRepresentativeWebRechargeUrl(
  representativeSlug: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const baseUrl =
    env.TELEGRAM_WEB_RECHARGE_BASE_URL?.trim()
    || env.NEXT_PUBLIC_REPRESENTATIVE_URL?.trim();
  const slug = representativeSlug.trim();
  if (!baseUrl || !slug) return null;

  try {
    const url = new URL(baseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username
      || url.password
    ) {
      return null;
    }
    url.pathname = [
      url.pathname.replace(/\/+$/, ""),
      "reps",
      encodeURIComponent(slug),
    ]
      .filter(Boolean)
      .join("/");
    if (!url.pathname.startsWith("/")) {
      url.pathname = `/${url.pathname}`;
    }
    url.search = "";
    url.searchParams.set("source", "telegram");
    url.hash = "recharge";
    return url.toString();
  } catch {
    return null;
  }
}

export function resolveTelegramInlineKeyboardUrl(
  candidate: string | null,
): string | null {
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || !isPublicNetworkHostname(url.hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isPublicNetworkHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
  ) {
    return false;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return isPublicIpv4(hostname);
  }
  if (ipVersion === 6) {
    return isPublicIpv6(hostname);
  }

  return hostname.includes(".");
}

function isPublicIpv4(hostname: string): boolean {
  const [first, second, third] = hostname
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (
    first === undefined
    || second === undefined
    || third === undefined
  ) {
    return false;
  }
  return !(
    first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
  );
}

function isPublicIpv6(hostname: string): boolean {
  const [firstPart = "0", secondPart = "0"] = hostname.split(":");
  const firstHextet = Number.parseInt(firstPart || "0", 16);
  const secondHextet = Number.parseInt(secondPart || "0", 16);
  if (
    !Number.isFinite(firstHextet)
    || !Number.isFinite(secondHextet)
    || (firstHextet === 0x2001 && secondHextet === 0)
    || (firstHextet === 0x2001 && secondHextet === 0x0db8)
    || (firstHextet === 0x2001 && (secondHextet & 0xfff0) === 0x20)
    || firstHextet === 0x2002
  ) {
    return false;
  }
  return (firstHextet & 0xe000) === 0x2000;
}

export function formatTelegramPlans(
  plans: PricingPlan[],
  starsPurchasesEnabled: boolean,
): string {
  return plans
    .map((plan) => {
      const price =
        starsPurchasesEnabled
          ? ` · ${plan.stars} Stars`
          : "";
      return `${plan.name}${price}\n${plan.summary}\nIncluded replies: ${plan.includedReplies}`;
    })
    .join("\n\n");
}

export function buildWebRechargeMessage(input: {
  representativeName: string;
  rechargeUrl: string | null;
  selectedPlanName?: string;
}): string {
  return [
    "当前充值与付费统一在 Web 完成。",
    "为确保权益回到同一个 Delegate 账户，请先在 Web 登录并完成 Telegram 绑定，再创建充值单。",
    input.selectedPlanName
      ? `你选择的是 ${input.selectedPlanName}，可在代表页面查看当前方案并继续服务。`
      : `请在 ${input.representativeName} 的代表页面查看方案并继续服务。`,
    input.rechargeUrl
      ? `Web 充值入口：${input.rechargeUrl}`
      : "Web 充值入口尚未配置，请联系代表所有者。",
  ].join("\n\n");
}
