import { headers } from "next/headers";

import { demoRepresentative } from "@delegate/domain";
import {
  extractCountryHint,
  resolveLocale,
  resolveServiceUrl,
} from "@delegate/web-ui";
import {
  getConversationDetailSnapshot,
  getRepresentativeOperationsSnapshot,
  listConversationInboxSnapshot,
  listRepresentativeDirectoryItems,
} from "@delegate/web-data";

import {
  buildCreatorLoginPathForReturnTo,
  buildCreatorLogoutPath,
  resolveCreatorAccountLabel,
} from "../../auth-guard";
import { requireOwnerAuthSession } from "../auth/owner-session";
import { DashboardFramework } from "./dashboard-framework";
import { isDashboardView } from "./dashboard-ui-data";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ rep?: string; view?: string; lang?: string; conversation?: string }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const ownerSession = await requireOwnerAuthSession(buildDashboardReturnTo(params));
  const headerStore = await headers();
  const locale = resolveLocale({
    requestedLocale: params?.lang,
    acceptLanguage: headerStore.get("accept-language"),
    countryHint: extractCountryHint(headerStore),
  });
  const representatives = await listRepresentativeDirectoryItems(ownerSession?.ownerId);
  const fallbackSlug = representatives[0]?.slug ?? demoRepresentative.slug;
  const requestedSlug = params?.rep?.trim();
  const requestedView = params?.view?.trim();
  const activeSlug =
    requestedSlug && representatives.some((representative) => representative.slug === requestedSlug)
      ? requestedSlug
      : fallbackSlug;
  const activeView = isDashboardView(requestedView) ? requestedView : "overview";
  const [inboxSnapshot, representativeOperations] = await Promise.all([
    activeView === "inbox"
      ? listConversationInboxSnapshot(activeSlug, ownerSession?.ownerId || "local-owner")
      : Promise.resolve(null),
    activeView === "representatives"
      ? getRepresentativeOperationsSnapshot(activeSlug)
      : Promise.resolve(null),
  ]);
  const selectedConversationId =
    params?.conversation?.trim() || inboxSnapshot?.conversations[0]?.id || null;
  const conversationDetail =
    activeView === "inbox" && selectedConversationId
      ? await getConversationDetailSnapshot(activeSlug, selectedConversationId)
      : null;
  const currentHost = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const websiteBaseUrl = resolveServiceUrl(process.env.NEXT_PUBLIC_SITE_URL, "http://localhost:3000", {
    currentAppDefaultPort: 3001,
    currentHost,
  });
  const representativeBaseUrl = resolveServiceUrl(
    process.env.NEXT_PUBLIC_REPRESENTATIVE_URL,
    "http://localhost:3002",
    {
      currentAppDefaultPort: 3001,
      currentHost,
    },
  );
  const dashboardReturnTo = buildDashboardReturnTo({
    rep: activeSlug,
    view: activeView,
    lang: locale,
  });
  const accountLabel = resolveCreatorAccountLabel(
    ownerSession,
    locale === "zh" ? "已登录主理人" : "Signed-in creator",
  );

  return (
    <DashboardFramework
      accountLabel={accountLabel}
      activeSlug={activeSlug}
      activeView={activeView}
      conversationDetail={conversationDetail}
      inboxSnapshot={inboxSnapshot}
      locale={locale}
      representativeOperations={representativeOperations}
      representativeBaseUrl={representativeBaseUrl}
      representatives={representatives}
      websiteBaseUrl={websiteBaseUrl}
      {...(ownerSession
        ? { logoutHref: buildCreatorLogoutPath(dashboardReturnTo) }
        : { loginHref: buildCreatorLoginPathForReturnTo(dashboardReturnTo) })}
    />
  );
}

function buildDashboardReturnTo(params: { rep?: string; view?: string; lang?: string; conversation?: string } | undefined): string {
  const search = new URLSearchParams();
  if (params?.rep) search.set("rep", params.rep);
  if (params?.view) search.set("view", params.view);
  if (params?.lang) search.set("lang", params.lang);
  if (params?.conversation) search.set("conversation", params.conversation);
  const query = search.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}
