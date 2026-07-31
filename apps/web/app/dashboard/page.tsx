import { cookies, headers } from "next/headers";

import {
  getCookieLocale,
  localeCookieName,
  normalizeLocale,
  resolveServiceUrl,
} from "@delegate/web-ui";
import {
  getConversationDetailSnapshot,
  getRepresentativeOperationsSnapshot,
  listConversationInboxSnapshot,
  listRepresentativeDirectoryItems,
} from "@delegate/web-data";
import {
  buildUnavailableOwnerOperationalAlertSummary,
  buildUnavailableOwnerSettingsSnapshot,
  getOwnerDashboardPreferences,
  getOwnerOperationalAlertSummary,
  getOwnerSettingsSnapshot,
} from "@delegate/web-data/owner-settings";

import {
  buildCreatorLoginPathForReturnTo,
  buildCreatorLogoutPath,
  resolveCreatorAccountLabel,
} from "../../auth-guard";
import { requireOwnerAuthSession } from "../auth/owner-session";
import { DashboardFramework } from "./dashboard-framework";
import { isDashboardView } from "./dashboard-ui-data";
import { parseSettingsSection } from "./settings-section-navigation";
import { listSettingsTimeZones } from "./settings-time-zones";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{
    rep?: string;
    view?: string;
    lang?: string;
    conversation?: string;
    settingsSection?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const ownerSession = await requireOwnerAuthSession(buildDashboardReturnTo(params));
  const requestedView = params?.view?.trim();
  const activeView = isDashboardView(requestedView) ? requestedView : "overview";
  const ownerId = ownerSession?.ownerId?.trim() || null;
  const unavailableSettings = buildUnavailableOwnerSettingsSnapshot();
  const unavailableAlerts = buildUnavailableOwnerOperationalAlertSummary();
  const [
    headerStore,
    cookieStore,
    representatives,
    ownerPreferences,
    ownerSettings,
    operationalAlerts,
  ] = await Promise.all([
    headers(),
    cookies(),
    listRepresentativeDirectoryItems(ownerId ?? undefined),
    ownerId
      ? getOwnerDashboardPreferences({ ownerId }).catch(() => null)
      : Promise.resolve(null),
    activeView === "settings" && ownerId
      ? getOwnerSettingsSnapshot({ ownerId }).catch(() => unavailableSettings)
      : Promise.resolve(unavailableSettings),
    ownerId
      ? getOwnerOperationalAlertSummary({ ownerId }).catch(() => unavailableAlerts)
      : Promise.resolve(unavailableAlerts),
  ]);
  const locale =
    normalizeLocale(params?.lang)
    ?? ownerPreferences?.preferredLocale
    ?? getCookieLocale(cookieStore.get(localeCookieName)?.value)
    ?? "zh";
  const fallbackSlug = representatives[0]?.slug ?? "";
  const requestedSlug = params?.rep?.trim();
  const activeSlug =
    requestedSlug && representatives.some((representative) => representative.slug === requestedSlug)
      ? requestedSlug
      : fallbackSlug;
  const settingsSection = parseSettingsSection(params?.settingsSection);
  const settingsTimeZones = listSettingsTimeZones(
    ownerSettings.profile?.timezone ?? "UTC",
  );
  const [inboxSnapshot, representativeOperations] = await Promise.all([
    activeView === "inbox" && activeSlug
      ? listConversationInboxSnapshot(
          activeSlug,
          ownerSession?.ownerId || "local-owner",
          ownerSession?.ownerId,
        )
      : Promise.resolve(null),
    activeView === "representatives" && activeSlug
      ? getRepresentativeOperationsSnapshot({
          representativeSlug: activeSlug,
          ownerId,
        })
      : Promise.resolve(null),
  ]);
  const selectedConversationId =
    params?.conversation?.trim() || inboxSnapshot?.conversations[0]?.id || null;
  const conversationDetail =
    activeView === "inbox" && selectedConversationId
      ? await getConversationDetailSnapshot(
          activeSlug,
          selectedConversationId,
          ownerSession?.ownerId,
        )
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
    ...(activeView === "settings" ? { settingsSection } : {}),
  });
  const accountLabel =
    ownerPreferences?.displayName.trim()
    || (ownerSession
      ? resolveCreatorAccountLabel(
          ownerSession,
          locale === "zh" ? "已登录主理人" : "Signed-in creator",
        )
      : locale === "zh"
        ? "本地 Dashboard"
        : "Local dashboard");

  return (
    <DashboardFramework
      accountLabel={accountLabel}
      activeSlug={activeSlug}
      activeView={activeView}
      conversationDetail={conversationDetail}
      inboxSnapshot={inboxSnapshot}
      locale={locale}
      operationalAlerts={operationalAlerts}
      ownerSettings={ownerSettings}
      representativeOperations={representativeOperations}
      representativeBaseUrl={representativeBaseUrl}
      representatives={representatives}
      settingsSection={settingsSection}
      settingsTimeZones={settingsTimeZones}
      websiteBaseUrl={websiteBaseUrl}
      {...(ownerSession
        ? { logoutHref: buildCreatorLogoutPath(dashboardReturnTo) }
        : { loginHref: buildCreatorLoginPathForReturnTo(dashboardReturnTo) })}
    />
  );
}

function buildDashboardReturnTo(params: {
  rep?: string;
  view?: string;
  lang?: string;
  conversation?: string;
  settingsSection?: string;
} | undefined): string {
  const search = new URLSearchParams();
  if (params?.rep) search.set("rep", params.rep);
  if (params?.view) search.set("view", params.view);
  if (params?.lang) search.set("lang", params.lang);
  if (params?.conversation) search.set("conversation", params.conversation);
  if (params?.settingsSection) search.set("settingsSection", params.settingsSection);
  const query = search.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}
