import type { PricingPlan } from "@delegate/domain";

export type TelegramBotCommand = {
  command: string;
  description: string;
};

export function buildTelegramBotCommands(
  starsPurchasesEnabled: boolean,
): TelegramBotCommand[] {
  return [
    { command: "start", description: "Introduce the representative" },
    { command: "plans", description: "Show service plans and continuation options" },
    ...(starsPurchasesEnabled
      ? [
          {
            command: "buy",
            description: "Buy Pass / Deep Help / Sponsor in Telegram Stars",
          },
        ]
      : []),
    { command: "compute", description: "Run a governed compute request in the sandbox" },
    { command: "bind", description: "Bind this Telegram account to your Delegate account" },
    { command: "paysupport", description: "Get payment and refund support" },
  ];
}

export function buildRepresentativeWebRechargeUrl(
  representativeSlug: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const baseUrl = env.NEXT_PUBLIC_REPRESENTATIVE_URL?.trim();
  const slug = representativeSlug.trim();
  if (!baseUrl || !slug) return null;

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
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
    url.hash = "recharge";
    return url.toString();
  } catch {
    return null;
  }
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
    input.selectedPlanName
      ? `你选择的是 ${input.selectedPlanName}，可在代表页面查看当前方案并继续服务。`
      : `请在 ${input.representativeName} 的代表页面查看方案并继续服务。`,
    input.rechargeUrl
      ? `Web 充值入口：${input.rechargeUrl}`
      : "Web 充值入口尚未配置，请联系代表所有者。",
  ].join("\n\n");
}
