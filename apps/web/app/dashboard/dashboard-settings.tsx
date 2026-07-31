"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import type {
  OwnerNotificationRules,
  OwnerOperationalAlertSummary,
  OwnerPreferredLocale,
  OwnerSettingsSnapshot,
} from "@delegate/web-data/owner-settings";
import type { Locale } from "@delegate/web-ui";

import {
  buildSettingsSectionHref,
  type SettingsSection,
} from "./settings-section-navigation";
import {
  isCurrentDocumentDestination,
  readDashboardHistoryMarker,
  resolveUnsavedHistoryTraversal,
  withDashboardHistoryMarker,
} from "./dashboard-history-state";
import { registerDashboardHistoryGuard } from "./dashboard-history-tracker";

type DashboardSettingsProps = {
  initialSnapshot: OwnerSettingsSnapshot;
  initialSection: SettingsSection;
  locale: Locale;
  logoutHref: string | undefined;
  alertSummary: OwnerOperationalAlertSummary;
  timeZones: string[];
};

type ProfileDraft = {
  displayName: string;
  timezone: string;
  preferredLocale: OwnerPreferredLocale | null;
};

type EditableNotificationEvent =
  | "handoffRequested"
  | "approvalRequested"
  | "channelFailure";

type FeedbackState = {
  kind: "success" | "error" | "conflict";
  title: string;
  message: string;
  reloadLabel?: string;
};

type SettingsErrorPayload = {
  error?: string;
  code?: string;
  fieldErrors?: Record<string, string>;
};

type PendingMutationRequest = {
  fingerprint: string;
  requestId: string;
};

class SettingsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly fieldErrors: Record<string, string>,
  ) {
    super(message);
    this.name = "SettingsRequestError";
  }
}

const savedFeedbackDurationMs = 1_200;

export function DashboardSettings({
  initialSnapshot,
  initialSection,
  locale,
  logoutHref,
  alertSummary,
  timeZones,
}: DashboardSettingsProps) {
  const copy = settingsCopy[locale];
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const allowNextUnloadRef = useRef(false);
  const mutationInFlightRef = useRef(false);
  const pendingMutationRequestsRef = useRef<
    Record<"profile" | "notifications", PendingMutationRequest | null>
  >({
    profile: null,
    notifications: null,
  });
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(
    () => profileDraftFromSnapshot(initialSnapshot),
  );
  const [notificationDraft, setNotificationDraft] =
    useState<OwnerNotificationRules>(
      () => notificationDraftFromSnapshot(initialSnapshot),
    );
  const [profileFieldErrors, setProfileFieldErrors] = useState<
    Record<string, string>
  >({});
  const [savingSection, setSavingSection] = useState<
    "profile" | "notifications" | null
  >(null);
  const [pendingNavigationHref, setPendingNavigationHref] =
    useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [, refreshControlledDraftAfterHistoryRollback] = useState(0);

  useEffect(() => {
    setSnapshot(initialSnapshot);
    setProfileDraft(profileDraftFromSnapshot(initialSnapshot));
    setNotificationDraft(notificationDraftFromSnapshot(initialSnapshot));
    setProfileFieldErrors({});
    setSavingSection(null);
    setPendingNavigationHref(null);
    mutationInFlightRef.current = false;
    pendingMutationRequestsRef.current = {
      profile: null,
      notifications: null,
    };
    setFeedback(null);
  }, [initialSnapshot, locale]);

  const profileDirty = isProfileDirty(snapshot, profileDraft);
  const notificationsDirty = isNotificationDirty(snapshot, notificationDraft);
  const hasUnsavedChanges = profileDirty || notificationsDirty;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNextUnloadRef.current) {
        allowNextUnloadRef.current = false;
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const navigation = (
      window as Window & {
        navigation?: EventTarget;
      }
    ).navigation;
    const allowNavigation = () => {
      allowNextUnloadRef.current = true;
      window.setTimeout(() => {
        allowNextUnloadRef.current = false;
      }, 1_000);
    };

    if (navigation) {
      const handleNavigation = (event: Event) => {
        const navigationEvent = event as Event & {
          destination?: { url?: string };
          downloadRequest?: string | null;
        };
        if (
          allowNextUnloadRef.current ||
          navigationEvent.downloadRequest ||
          !navigationEvent.cancelable
        ) {
          return;
        }
        const destinationUrl = navigationEvent.destination?.url;
        if (!destinationUrl || destinationUrl === window.location.href) return;
        if (!window.confirm(copy.unsavedConfirmation)) {
          navigationEvent.preventDefault();
          return;
        }
        allowNavigation();
      };
      navigation.addEventListener("navigate", handleNavigation);
      return () => navigation.removeEventListener("navigate", handleNavigation);
    }

    const guardedMarker = readDashboardHistoryMarker(window.history.state);
    if (!guardedMarker) return;
    let rollbackExpectedPosition: number | null = null;
    const handleHistoryNavigation = (
      event: PopStateEvent,
      trackedDestinationMarker: {
        lineage: string;
        position: number;
      } | null,
    ) => {
      const destinationMarker =
        trackedDestinationMarker
        ?? readDashboardHistoryMarker(event.state);
      if (rollbackExpectedPosition !== null) {
        event.stopImmediatePropagation();
        if (
          destinationMarker?.lineage === guardedMarker.lineage
          && destinationMarker.position === rollbackExpectedPosition
        ) {
          rollbackExpectedPosition = null;
          refreshControlledDraftAfterHistoryRollback(
            (revision) => revision + 1,
          );
          return true;
        }
        if (destinationMarker?.lineage === guardedMarker.lineage) {
          const correction =
            rollbackExpectedPosition - destinationMarker.position;
          queueMicrotask(() => window.history.go(correction));
        }
        return true;
      }
      if (allowNextUnloadRef.current) return false;
      const destinationState = destinationMarker
        ? withDashboardHistoryMarker(event.state, destinationMarker)
        : event.state;
      const traversal = resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker,
        destinationState,
      });
      if (traversal.action === "bypass" || traversal.action === "stay") {
        return false;
      }
      if (window.confirm(copy.unsavedConfirmation)) {
        allowNavigation();
        return false;
      }
      const rollback = resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker,
        destinationState,
      });
      if (rollback.action !== "rollback") return false;
      event.stopImmediatePropagation();
      rollbackExpectedPosition = guardedMarker.position;
      queueMicrotask(() => window.history.go(rollback.delta));
      return true;
    };
    return registerDashboardHistoryGuard(
      window,
      handleHistoryNavigation,
    );
  }, [copy.unsavedConfirmation, hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleDocumentNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (destination.protocol !== "http:" && destination.protocol !== "https:") {
        return;
      }
      if (
        isCurrentDocumentDestination(
          window.location.href,
          destination.href,
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!window.confirm(copy.unsavedConfirmation)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      allowNextUnloadRef.current = true;
      window.setTimeout(() => {
        allowNextUnloadRef.current = false;
      }, 1_000);
    };
    document.addEventListener("click", handleDocumentNavigation, true);
    return () =>
      document.removeEventListener("click", handleDocumentNavigation, true);
  }, [copy.unsavedConfirmation, hasUnsavedChanges]);

  useEffect(() => {
    if (!pendingNavigationHref) return;
    const timeout = window.setTimeout(() => {
      allowNextUnloadRef.current = true;
      window.location.assign(pendingNavigationHref);
    }, savedFeedbackDurationMs);
    return () => window.clearTimeout(timeout);
  }, [pendingNavigationHref]);

  useEffect(() => {
    if (feedback?.kind !== "success") return;
    const timeout = window.setTimeout(() => setFeedback(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  const clientProfileErrors = validateProfileDraft(
    profileDraft,
    copy,
    timeZones,
  );
  const effectiveProfileErrors = {
    ...profileFieldErrors,
    ...clientProfileErrors,
  };
  const profileAvailable =
    snapshot.persistenceAvailable && snapshot.profile !== null;
  const notificationsAvailable =
    snapshot.persistenceAvailable && snapshot.notifications !== null;
  const navigationPending = pendingNavigationHref !== null;

  function discardProfile() {
    setProfileDraft(profileDraftFromSnapshot(snapshot));
    setProfileFieldErrors({});
    setFeedback(null);
  }

  function discardNotifications() {
    setNotificationDraft(notificationDraftFromSnapshot(snapshot));
    setFeedback(null);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    const validation = validateProfileDraft(profileDraft, copy, timeZones);
    const preferredLocale = profileDraft.preferredLocale;
    setProfileFieldErrors(validation);
    if (
      Object.keys(validation).length > 0 ||
      preferredLocale === null ||
      !snapshot.profile ||
      !profileAvailable
    ) {
      if (!profileAvailable) {
        setFeedback({
          kind: "error",
          title: copy.persistenceUnavailableTitle,
          message: copy.persistenceUnavailableMessage,
        });
      }
      return;
    }

    mutationInFlightRef.current = true;
    setSavingSection("profile");
    setFeedback(null);
    try {
      const body = {
        section: "profile",
        profile: {
          displayName: profileDraft.displayName.trim(),
          timezone: profileDraft.timezone,
          preferredLocale,
          expectedVersion: snapshot.profile.version,
        },
      } as const;
      const nextSnapshot = await patchOwnerSettings(
        body,
        getOrCreateMutationRequestId(
          pendingMutationRequestsRef,
          "profile",
          body,
        ),
      );
      setSnapshot(nextSnapshot);
      setProfileDraft(profileDraftFromSnapshot(nextSnapshot));
      setNotificationDraft(notificationDraftFromSnapshot(nextSnapshot));
      setProfileFieldErrors({});
      setFeedback({
        kind: "success",
        title: copy.profileSavedTitle,
        message: copy.profileSavedMessage,
      });
      const nextLocale = nextSnapshot.profile?.preferredLocale ?? locale;
      setPendingNavigationHref(buildSettingsSectionHref({
        currentSearch: searchParams.toString(),
        locale: nextLocale,
        pathname,
        section: initialSection,
      }));
    } catch (error) {
      mutationInFlightRef.current = false;
      applyMutationError(error, "profile");
    } finally {
      setSavingSection(null);
    }
  }

  async function saveNotifications(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    if (!snapshot.notifications || !notificationsAvailable) {
      setFeedback({
        kind: "error",
        title: copy.persistenceUnavailableTitle,
        message: copy.persistenceUnavailableMessage,
      });
      return;
    }

    mutationInFlightRef.current = true;
    setSavingSection("notifications");
    setFeedback(null);
    try {
      const body = {
        section: "notifications",
        notifications: {
          rules: {
            ...notificationDraft,
            events: {
              ...notificationDraft.events,
              walletException: true,
            },
          },
          expectedVersion: snapshot.notifications.version,
        },
      } as const;
      const nextSnapshot = await patchOwnerSettings(
        body,
        getOrCreateMutationRequestId(
          pendingMutationRequestsRef,
          "notifications",
          body,
        ),
      );
      setSnapshot(nextSnapshot);
      setProfileDraft(profileDraftFromSnapshot(nextSnapshot));
      setNotificationDraft(notificationDraftFromSnapshot(nextSnapshot));
      setFeedback({
        kind: "success",
        title: copy.notificationsSavedTitle,
        message: copy.notificationsSavedMessage,
      });
      setPendingNavigationHref(buildSettingsSectionHref({
        currentSearch: searchParams.toString(),
        locale,
        pathname,
        section: initialSection,
      }));
    } catch (error) {
      mutationInFlightRef.current = false;
      applyMutationError(error, "notifications");
    } finally {
      setSavingSection(null);
    }
  }

  function applyMutationError(
    error: unknown,
    section: "profile" | "notifications",
  ) {
    if (error instanceof SettingsRequestError) {
      const localizedFieldErrors = localizeSettingsFieldErrors(
        error.fieldErrors,
        copy,
      );
      if (section === "profile" && Object.keys(localizedFieldErrors).length) {
        setProfileFieldErrors(localizedFieldErrors);
      }
      const conflict =
        error.status === 409 ||
        error.code === "owner_settings_version_conflict";
      const authenticationRequired = error.status === 401;
      setFeedback({
        kind: conflict ? "conflict" : "error",
        title: conflict
          ? copy.conflictTitle
          : authenticationRequired
            ? copy.sessionExpiredTitle
            : copy.saveFailedTitle,
        message: conflict
          ? copy.conflictMessage
          : authenticationRequired
            ? copy.sessionExpiredMessage
            : localizeSettingsRequestError(error, copy),
        ...(conflict
          ? { reloadLabel: copy.reloadLatest }
          : authenticationRequired
            ? { reloadLabel: copy.signInAgain }
            : {}),
      });
      return;
    }
    setFeedback({
      kind: "error",
      title: copy.saveFailedTitle,
      message: copy.networkErrorMessage,
    });
  }

  function updateNotification(
    event: EditableNotificationEvent,
    enabled: boolean,
  ) {
    setNotificationDraft((current) => ({
      ...current,
      events: {
        ...current.events,
        [event]: enabled,
        walletException: true,
      },
    }));
  }

  return (
    <section
      aria-labelledby="dashboard-settings-title"
      className="settings-module"
    >
      <header className="dashboard-v2-page-header settings-page-header">
        <div>
          <p>SETTINGS / 11</p>
          <h1 id="dashboard-settings-title">{copy.pageTitle}</h1>
          <span>{copy.pageDescription}</span>
        </div>
      </header>

      <nav
        aria-label={copy.sectionNavigationLabel}
        className="dashboard-v2-subnav settings-section-navigation"
      >
        {(
          [
            ["profile", copy.profileTab],
            ["security", copy.securityTab],
            ["notifications", copy.notificationsTab],
          ] as const
        ).map(([section, label]) => (
          <a
            aria-current={initialSection === section ? "page" : undefined}
            className={initialSection === section ? "is-active" : undefined}
            href={buildSettingsSectionHref({
              currentSearch: searchParams.toString(),
              locale,
              pathname,
              section,
            })}
            key={section}
          >
            {label}
          </a>
        ))}
      </nav>

      {feedback ? (
        <div className="settings-feedback-viewport">
          <div className={`settings-feedback is-${feedback.kind}`}>
            <div
              className="settings-feedback-announcement"
              role={feedback.kind === "success" ? "status" : "alert"}
            >
              <span aria-hidden="true">
                {feedback.kind === "success"
                  ? "✓"
                  : feedback.kind === "conflict"
                    ? "↻"
                    : "!"}
              </span>
              <div>
                <strong>{feedback.title}</strong>
                <p>{feedback.message}</p>
              </div>
            </div>
            {feedback.reloadLabel ? (
              <button
                className="settings-feedback-reload"
                onClick={() => {
                  allowNextUnloadRef.current = true;
                  window.location.reload();
                }}
                type="button"
              >
                {feedback.reloadLabel}
              </button>
            ) : null}
            <button
              aria-label={copy.dismissFeedback}
              className="settings-feedback-close"
              onClick={() => setFeedback(null)}
              type="button"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      {!snapshot.persistenceAvailable ? (
        <div className="settings-unavailable" role="status">
          <strong>{copy.persistenceUnavailableTitle}</strong>
          <p>{copy.persistenceUnavailableMessage}</p>
        </div>
      ) : null}

      {initialSection === "profile" ? (
        <form
          aria-busy={savingSection === "profile"}
          aria-labelledby="settings-profile-heading"
          className="settings-form-stack"
          onSubmit={saveProfile}
        >
          <SettingsCard
            description={copy.profileCardDescription}
            eyebrow={copy.profileEyebrow}
            headingId="settings-profile-heading"
            title={copy.profileCardTitle}
          >
            <div className="settings-field-grid">
              <label className="settings-field settings-field-wide">
                <span>{copy.displayNameLabel}</span>
                <input
                  aria-describedby={
                    effectiveProfileErrors.displayName
                      ? "settings-display-name-error"
                      : "settings-display-name-help"
                  }
                  aria-invalid={
                    effectiveProfileErrors.displayName ? true : undefined
                  }
                  disabled={
                    !profileAvailable ||
                    savingSection === "profile" ||
                    navigationPending
                  }
                  maxLength={80}
                  onChange={(event) => {
                    setProfileDraft((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }));
                    setProfileFieldErrors((current) => ({
                      ...current,
                      displayName: "",
                    }));
                  }}
                  value={profileDraft.displayName}
                />
                {effectiveProfileErrors.displayName ? (
                  <small
                    className="settings-field-error"
                    id="settings-display-name-error"
                  >
                    {effectiveProfileErrors.displayName}
                  </small>
                ) : (
                  <small id="settings-display-name-help">
                    {copy.displayNameHelp}
                  </small>
                )}
              </label>
            </div>
          </SettingsCard>

          <SettingsCard
            description={copy.preferencesCardDescription}
            eyebrow={copy.preferencesEyebrow}
            title={copy.preferencesCardTitle}
          >
            <div className="settings-field-grid">
              <label className="settings-field">
                <span>{copy.timezoneLabel}</span>
                <select
                  aria-describedby={
                    effectiveProfileErrors.timezone
                      ? "settings-timezone-error"
                      : "settings-timezone-help"
                  }
                  aria-invalid={
                    effectiveProfileErrors.timezone ? true : undefined
                  }
                  disabled={
                    !profileAvailable ||
                    savingSection === "profile" ||
                    navigationPending
                  }
                  onChange={(event) => {
                    setProfileDraft((current) => ({
                      ...current,
                      timezone: event.target.value,
                    }));
                    setProfileFieldErrors((current) => ({
                      ...current,
                      timezone: "",
                    }));
                  }}
                  value={profileDraft.timezone}
                >
                  {!timeZones.includes(profileDraft.timezone) ? (
                    <option disabled value={profileDraft.timezone}>
                      {copy.invalidStoredTimeZone(profileDraft.timezone)}
                    </option>
                  ) : null}
                  {timeZones.map((timeZone) => (
                    <option key={timeZone} value={timeZone}>
                      {timeZone}
                    </option>
                  ))}
                </select>
                {effectiveProfileErrors.timezone ? (
                  <small
                    className="settings-field-error"
                    id="settings-timezone-error"
                  >
                    {effectiveProfileErrors.timezone}
                  </small>
                ) : (
                  <small id="settings-timezone-help">{copy.timezoneHelp}</small>
                )}
              </label>

              <label className="settings-field">
                <span>{copy.languageLabel}</span>
                <select
                  aria-describedby={
                    effectiveProfileErrors.preferredLocale
                      ? "settings-language-error"
                      : "settings-language-help"
                  }
                  aria-invalid={
                    effectiveProfileErrors.preferredLocale ? true : undefined
                  }
                  disabled={
                    !profileAvailable ||
                    savingSection === "profile" ||
                    navigationPending
                  }
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      preferredLocale:
                        event.target.value as OwnerPreferredLocale,
                    }))
                  }
                  value={profileDraft.preferredLocale ?? "zh"}
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
                {effectiveProfileErrors.preferredLocale ? (
                  <small
                    className="settings-field-error"
                    id="settings-language-error"
                  >
                    {effectiveProfileErrors.preferredLocale}
                  </small>
                ) : (
                  <small id="settings-language-help">{copy.languageHelp}</small>
                )}
              </label>
            </div>
          </SettingsCard>

          <SettingsFormActions
            available={profileAvailable}
            dirty={profileDirty}
            disabled={
              Object.keys(clientProfileErrors).length > 0 ||
              savingSection === "profile" ||
              navigationPending
            }
            discardLabel={copy.discard}
            onDiscard={discardProfile}
            saveLabel={
              savingSection === "profile" ? copy.saving : copy.saveProfile
            }
            statusLabel={
              !profileAvailable
                ? copy.notPersisted
                : profileDirty
                  ? copy.unsavedChanges
                  : copy.allChangesSaved
            }
          />
        </form>
      ) : null}

      {initialSection === "security" ? (
        <div
          aria-labelledby="settings-security-heading"
          className="settings-form-stack"
        >
          <SettingsCard
            description={copy.securityCardDescription}
            eyebrow={copy.securityEyebrow}
            headingId="settings-security-heading"
            title={copy.securityCardTitle}
          >
            <dl className="settings-fact-list">
              <SettingsFact
                label={copy.providerLabel}
                value={
                  snapshot.security.provider === "logto"
                    ? "Logto"
                    : copy.notConnected
                }
              />
              <SettingsFact
                label={copy.connectionLabel}
                tone={
                  snapshot.security.connectionStatus === "connected"
                    ? "safe"
                    : "neutral"
                }
                value={
                  snapshot.security.connectionStatus === "connected"
                    ? copy.connected
                    : copy.unavailable
                }
              />
              <SettingsFact
                detail={verificationLabel(
                  snapshot.security.emailVerification,
                  copy,
                )}
                label={copy.emailLabel}
                tone={
                  snapshot.security.emailVerification === "verified"
                    ? "safe"
                    : "neutral"
                }
                value={snapshot.security.email ?? copy.notProvided}
              />
              <SettingsFact
                detail={verificationLabel(
                  snapshot.security.phoneVerification,
                  copy,
                )}
                label={copy.phoneLabel}
                tone={
                  snapshot.security.phoneVerification === "verified"
                    ? "safe"
                    : "neutral"
                }
                value={snapshot.security.phone ?? copy.notProvided}
              />
              <SettingsFact
                label={copy.identityVerifiedAtLabel}
                value={
                  <SettingsTimestamp
                    fallback={copy.notAvailable}
                    locale={locale}
                    timeZone={snapshot.profile?.timezone ?? "UTC"}
                    value={snapshot.security.identityVerifiedAt}
                  />
                }
              />
            </dl>

            <div className="settings-card-actions">
              {snapshot.security.managementUrl ? (
                <a
                  className="dashboard-v2-button-primary"
                  href={snapshot.security.managementUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {copy.manageLoginSecurity}
                  <span aria-hidden="true">↗</span>
                  <span className="sr-only">{copy.opensNewWindow}</span>
                </a>
              ) : (
                <p className="settings-action-note">
                  {copy.managementUnavailable}
                </p>
              )}
            </div>
          </SettingsCard>

          <SettingsCard
            description={copy.sessionCardDescription}
            eyebrow={copy.sessionEyebrow}
            title={copy.sessionCardTitle}
          >
            <div className="settings-session-note">
              <strong>
                {logoutHref
                  ? copy.currentBrowserSession
                  : copy.sessionUnavailable}
              </strong>
              <p>
                {logoutHref
                  ? copy.currentSessionExplanation
                  : copy.sessionUnavailableExplanation}
              </p>
            </div>
            {logoutHref ? (
              <div className="settings-card-actions">
                <form action={logoutHref} method="post">
                  <button
                    className="dashboard-v2-button-secondary"
                    type="submit"
                  >
                    {copy.signOutCurrentSession}
                  </button>
                </form>
              </div>
            ) : null}
          </SettingsCard>
        </div>
      ) : null}

      {initialSection === "notifications" ? (
        <form
          aria-busy={savingSection === "notifications"}
          aria-labelledby="settings-notifications-heading"
          className="settings-form-stack"
          onSubmit={saveNotifications}
        >
          <SettingsCard
            description={copy.notificationsCardDescription}
            eyebrow={copy.notificationsEyebrow}
            headingId="settings-notifications-heading"
            title={copy.notificationsCardTitle}
          >
            <div className="settings-delivery-note">
              <strong>{copy.dashboardNavigationOnly}</strong>
              <p>{copy.dashboardNavigationOnlyDescription}</p>
            </div>

            <fieldset
              className="settings-rule-fieldset"
              disabled={
                !notificationsAvailable ||
                savingSection === "notifications" ||
                navigationPending
              }
            >
              <legend>{copy.operationalAlertsLegend}</legend>
              <NotificationRule
                checked={notificationDraft.events.handoffRequested}
                count={operationalCount(
                  alertSummary,
                  alertSummary.topics.handoffs.count,
                  copy,
                )}
                description={copy.handoffDescription}
                label={copy.handoffLabel}
                onChange={(enabled) =>
                  updateNotification("handoffRequested", enabled)
                }
                stateLabels={copy.switchState}
              />
              <NotificationRule
                checked={notificationDraft.events.approvalRequested}
                count={operationalCount(
                  alertSummary,
                  alertSummary.topics.approvals.count,
                  copy,
                )}
                description={copy.approvalDescription}
                label={copy.approvalLabel}
                onChange={(enabled) =>
                  updateNotification("approvalRequested", enabled)
                }
                stateLabels={copy.switchState}
              />
              <NotificationRule
                alwaysOn
                checked
                count={operationalCount(
                  alertSummary,
                  alertSummary.topics.walletIssues.count,
                  copy,
                )}
                description={copy.walletExceptionDescription}
                label={copy.walletExceptionLabel}
                onChange={() => undefined}
                stateLabels={copy.switchState}
              />
              <NotificationRule
                checked={notificationDraft.events.channelFailure}
                count={operationalCount(
                  alertSummary,
                  alertSummary.topics.channelIssues.count,
                  copy,
                )}
                description={copy.channelFailureDescription}
                label={copy.channelFailureLabel}
                onChange={(enabled) =>
                  updateNotification("channelFailure", enabled)
                }
                stateLabels={copy.switchState}
              />
            </fieldset>
          </SettingsCard>

          <SettingsFormActions
            available={notificationsAvailable}
            dirty={notificationsDirty}
            disabled={
              savingSection === "notifications" ||
              navigationPending
            }
            discardLabel={copy.discard}
            onDiscard={discardNotifications}
            saveLabel={
              savingSection === "notifications"
                ? copy.saving
                : copy.saveNotifications
            }
            statusLabel={
              !notificationsAvailable
                ? copy.notPersisted
                : notificationsDirty
                  ? copy.unsavedChanges
                  : copy.allChangesSaved
            }
          />
        </form>
      ) : null}
    </section>
  );
}

function SettingsCard({
  children,
  description,
  eyebrow,
  headingId,
  title,
}: {
  children: ReactNode;
  description: string;
  eyebrow: string;
  headingId?: string;
  title: string;
}) {
  return (
    <article className="dashboard-v2-panel settings-card">
      <header>
        <div>
          <p>{eyebrow}</p>
          <h2 id={headingId}>{title}</h2>
        </div>
      </header>
      <p className="settings-card-description">{description}</p>
      {children}
    </article>
  );
}

function SettingsFormActions({
  available,
  dirty,
  disabled,
  discardLabel,
  onDiscard,
  saveLabel,
  statusLabel,
}: {
  available: boolean;
  dirty: boolean;
  disabled: boolean;
  discardLabel: string;
  onDiscard: () => void;
  saveLabel: string;
  statusLabel: string;
}) {
  return (
    <footer className="settings-form-actions">
      <span className={dirty ? "is-dirty" : undefined}>{statusLabel}</span>
      <div>
        <button
          className="dashboard-v2-button-secondary"
          disabled={!available || !dirty || disabled}
          onClick={onDiscard}
          type="button"
        >
          {discardLabel}
        </button>
        <button
          className="dashboard-v2-button-primary"
          disabled={!available || !dirty || disabled}
          type="submit"
        >
          {saveLabel}
        </button>
      </div>
    </footer>
  );
}

function SettingsFact({
  detail,
  label,
  tone = "neutral",
  value,
}: {
  detail?: string;
  label: string;
  tone?: "safe" | "neutral";
  value: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {detail ? <small className={`is-${tone}`}>{detail}</small> : null}
      </dd>
    </div>
  );
}

function NotificationRule({
  alwaysOn = false,
  checked,
  count,
  description,
  label,
  onChange,
  stateLabels,
}: {
  alwaysOn?: boolean;
  checked: boolean;
  count: string;
  description: string;
  label: string;
  onChange: (enabled: boolean) => void;
  stateLabels: { on: string; off: string; alwaysOn: string };
}) {
  return (
    <div className="settings-rule-row">
      <div>
        <span>{count}</span>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      {alwaysOn ? (
        <span className="settings-always-on">{stateLabels.alwaysOn}</span>
      ) : (
        <label className="settings-switch">
          <input
            aria-label={label}
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          <span aria-hidden="true" />
          <b>{checked ? stateLabels.on : stateLabels.off}</b>
        </label>
      )}
    </div>
  );
}

async function patchOwnerSettings(
  body: Record<string, unknown>,
  requestId: string,
): Promise<OwnerSettingsSnapshot> {
  const response = await fetch("/api/dashboard/settings", {
    method: "PATCH",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (OwnerSettingsSnapshot & { requestId?: string })
    | SettingsErrorPayload
    | null;
  if (!response.ok) {
    const errorPayload = payload as SettingsErrorPayload | null;
    throw new SettingsRequestError(
      errorPayload?.error || "Failed to update account settings.",
      response.status,
      errorPayload?.code ?? null,
      errorPayload?.fieldErrors ?? {},
    );
  }
  if (!payload || !("persistenceAvailable" in payload)) {
    throw new Error("Settings response is incomplete.");
  }
  return payload;
}

function getOrCreateMutationRequestId(
  requestsRef: {
    current: Record<
      "profile" | "notifications",
      PendingMutationRequest | null
    >;
  },
  section: "profile" | "notifications",
  body: Record<string, unknown>,
) {
  const fingerprint = JSON.stringify(body);
  const pending = requestsRef.current[section];
  if (pending?.fingerprint === fingerprint) return pending.requestId;
  const requestId = createRequestToken();
  requestsRef.current[section] = { fingerprint, requestId };
  return requestId;
}

function createRequestToken() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `settings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function profileDraftFromSnapshot(
  snapshot: OwnerSettingsSnapshot,
): ProfileDraft {
  return {
    displayName: snapshot.profile?.displayName ?? "",
    timezone: snapshot.profile?.timezone ?? "UTC",
    preferredLocale: snapshot.profile?.preferredLocale ?? "zh",
  };
}

function notificationDraftFromSnapshot(
  snapshot: OwnerSettingsSnapshot,
): OwnerNotificationRules {
  return snapshot.notifications
    ? structuredClone(snapshot.notifications.rules)
    : {
        schemaVersion: 1,
        events: {
          handoffRequested: false,
          approvalRequested: false,
          walletException: true,
          channelFailure: false,
        },
      };
}

function isProfileDirty(
  snapshot: OwnerSettingsSnapshot,
  draft: ProfileDraft,
) {
  const profile = snapshot.profile;
  return Boolean(
    profile &&
      (profile.displayName !== draft.displayName ||
        profile.timezone !== draft.timezone ||
        (profile.preferredLocale ?? "zh") !== draft.preferredLocale),
  );
}

function isNotificationDirty(
  snapshot: OwnerSettingsSnapshot,
  draft: OwnerNotificationRules,
) {
  const rules = snapshot.notifications?.rules;
  return Boolean(
    rules &&
      (rules.events.handoffRequested !== draft.events.handoffRequested ||
        rules.events.approvalRequested !== draft.events.approvalRequested ||
        rules.events.channelFailure !== draft.events.channelFailure),
  );
}

function validateProfileDraft(
  draft: ProfileDraft,
  copy: (typeof settingsCopy)[Locale],
  timeZones: readonly string[],
) {
  const errors: Record<string, string> = {};
  const displayName = draft.displayName.trim();
  if (!displayName) {
    errors.displayName = copy.displayNameRequired;
  } else if (displayName.length > 80) {
    errors.displayName = copy.displayNameTooLong;
  }
  if (!timeZones.includes(draft.timezone)) {
    errors.timezone = copy.timezoneInvalid;
  }
  if (draft.preferredLocale !== "zh" && draft.preferredLocale !== "en") {
    errors.preferredLocale = copy.languageInvalid;
  }
  return errors;
}

function verificationLabel(
  value: "verified" | "unknown",
  copy: (typeof settingsCopy)[Locale],
) {
  return value === "verified" ? copy.verified : copy.verificationUnknown;
}

function SettingsTimestamp({
  fallback,
  locale,
  timeZone,
  value,
}: {
  fallback: string;
  locale: Locale;
  timeZone: string;
  value: string | null;
}) {
  const renderKey = `${locale}\u0000${timeZone}\u0000${value ?? ""}`;
  const [formatted, setFormatted] = useState<{
    key: string;
    value: string;
  } | null>(null);
  useEffect(() => {
    setFormatted({
      key: renderKey,
      value: formatSettingsTimestamp(value, locale, timeZone, fallback),
    });
  }, [fallback, locale, renderKey, timeZone, value]);
  return formatted?.key === renderKey ? formatted.value : fallback;
}

function localizeSettingsFieldErrors(
  fieldErrors: Record<string, string>,
  copy: (typeof settingsCopy)[Locale],
) {
  const messages: Record<string, string> = {
    displayName: copy.displayNameInvalid,
    timezone: copy.timezoneInvalid,
    preferredLocale: copy.languageInvalid,
  };
  return Object.fromEntries(
    Object.keys(fieldErrors)
      .filter((field) => field in messages)
      .map((field) => [field, messages[field] as string]),
  );
}

function localizeSettingsRequestError(
  error: SettingsRequestError,
  copy: (typeof settingsCopy)[Locale],
) {
  if (
    error.status === 503
    || error.code === "owner_settings_persistence_unavailable"
  ) {
    return copy.persistenceSaveError;
  }
  if (error.status >= 500) return copy.serverSaveError;
  if (error.status === 400 || error.code === "owner_settings_invalid") {
    return copy.invalidSettingsMessage;
  }
  if (error.status === 404 || error.code === "owner_settings_not_found") {
    return copy.settingsNotFoundMessage;
  }
  return copy.saveRejectedMessage;
}

function operationalCount(
  summary: OwnerOperationalAlertSummary,
  count: number,
  copy: (typeof settingsCopy)[Locale],
) {
  return summary.dataSource === "database"
    ? copy.openItems(count)
    : copy.countUnavailable;
}

function formatSettingsTimestamp(
  value: string | null,
  locale: Locale,
  timeZone: string,
  fallback: string,
) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(parsed);
  } catch {
    return fallback;
  }
}

const settingsCopy = {
  zh: {
    pageTitle: "管理你的账户资料、安全入口和 Dashboard 提醒。",
    pageDescription:
      "这里的设置属于当前 Owner，不会改动任何数字代表的身份、知识、价格或发布版本。",
    sectionNavigationLabel: "设置分区",
    profileTab: "资料与偏好",
    securityTab: "登录与安全",
    notificationsTab: "提醒",
    profileEyebrow: "Owner profile",
    profileCardTitle: "账户资料",
    profileCardDescription:
      "显示名称用于 Owner 控制面和需要明确操作者身份的业务记录。",
    displayNameLabel: "显示名称",
    displayNameHelp:
      "最多 80 个字符；不会修改数字代表名称或公开页面上的 Owner 署名。",
    displayNameRequired: "请输入显示名称。",
    displayNameTooLong: "显示名称不能超过 80 个字符。",
    displayNameInvalid: "请输入 1–80 个字符的有效显示名称。",
    preferencesEyebrow: "Preferences",
    preferencesCardTitle: "区域与界面偏好",
    preferencesCardDescription:
      "时区用于业务时间的显示；界面语言是账户默认值，URL 中的 lang 参数仍可临时覆盖。",
    timezoneLabel: "时区",
    timezoneHelp: "使用标准 IANA 时区并自动处理夏令时。",
    timezoneInvalid: "请选择有效的 IANA 时区。",
    invalidStoredTimeZone: (timeZone: string) => `需更新：${timeZone}`,
    languageLabel: "默认界面语言",
    languageHelp: "保存后用于后续 Dashboard 访问。",
    languageInvalid: "请选择支持的界面语言。",
    profileSavedTitle: "资料已保存",
    profileSavedMessage: "Owner 资料与偏好已经更新。",
    securityEyebrow: "Sign-in identity",
    securityCardTitle: "登录身份",
    securityCardDescription:
      "Delegate 只显示真实的 Logto 连接信息；密码、通行密钥和 MFA 由身份提供商管理。",
    providerLabel: "身份提供商",
    connectionLabel: "连接状态",
    emailLabel: "登录邮箱",
    phoneLabel: "登录手机号",
    identityVerifiedAtLabel: "身份最近验证",
    connected: "已连接",
    unavailable: "不可用",
    notConnected: "未连接",
    notProvided: "未提供",
    notAvailable: "暂无",
    verified: "已验证",
    verificationUnknown: "验证状态未知",
    manageLoginSecurity: "管理登录安全",
    managementUnavailable:
      "当前部署未配置 Logto 自助安全入口。Delegate 不会提供无效的管理按钮。",
    opensNewWindow: "在新窗口打开",
    sessionEyebrow: "Current session",
    sessionCardTitle: "当前浏览器会话",
    sessionCardDescription:
      "当前版本只支持退出这个浏览器会话，不会虚构设备列表或其他会话的撤销能力。",
    currentBrowserSession: "已签名的 Owner 会话",
    currentSessionExplanation:
      "Delegate 使用受保护的浏览器 Cookie 保持登录。其他设备和 MFA 状态仍由 Logto 管理。",
    sessionUnavailable: "当前没有可验证的 Owner 会话",
    sessionUnavailableExplanation:
      "此环境可能启用了本地认证绕过。Delegate 不会把它描述成已签名的 Logto 会话。",
    signOutCurrentSession: "退出当前会话",
    notificationsEyebrow: "Dashboard navigation",
    notificationsCardTitle: "运营提醒",
    notificationsCardDescription:
      "控制哪些真实待处理事项进入 Dashboard 导航提醒；关闭规则不会删除对应业务记录。",
    dashboardNavigationOnly: "仅 Dashboard 导航提醒",
    dashboardNavigationOnlyDescription:
      "当前能力不会发送邮件、短信或 Webhook，也没有静默时段设置。",
    operationalAlertsLegend: "提醒主题",
    handoffLabel: "人工接管请求",
    handoffDescription: "显示仍处于 OPEN 或 REVIEWING 的 Handoff。",
    approvalLabel: "待审批 Action",
    approvalDescription: "显示仍等待 Owner 决定的审批请求。",
    walletExceptionLabel: "钱包异常",
    walletExceptionDescription:
      "资金异常始终进入提醒，不能在设置中关闭。",
    channelFailureLabel: "渠道故障",
    channelFailureDescription:
      "显示目标为 Active 但健康状态已降级或异常的发布渠道。",
    switchState: { on: "开启", off: "关闭", alwaysOn: "始终开启" },
    openItems: (count: number) => `${count} 个待处理`,
    countUnavailable: "计数不可用",
    notificationsSavedTitle: "提醒已保存",
    notificationsSavedMessage: "Dashboard 导航提醒规则已经更新。",
    saveNotifications: "保存提醒",
    saveProfile: "保存资料",
    saveFailedTitle: "保存失败",
    networkErrorMessage: "无法保存设置，请检查连接后重试。",
    invalidSettingsMessage: "请检查标记的设置后重试。",
    settingsNotFoundMessage: "当前 Owner 设置不存在，请刷新页面后重试。",
    persistenceSaveError: "设置存储暂时不可用，请稍后重试。",
    serverSaveError: "服务暂时无法保存设置，请稍后重试。",
    saveRejectedMessage: "这次设置更改未被接受，请刷新页面后重试。",
    sessionExpiredTitle: "登录已过期",
    sessionExpiredMessage: "请重新登录后再保存；当前输入仍保留在页面中。",
    signInAgain: "重新登录",
    conflictTitle: "设置已发生变化",
    conflictMessage:
      "其他页面已经更新了这组设置。你的输入仍被保留，请重新加载最新值后再修改。",
    reloadLatest: "重新加载",
    dismissFeedback: "关闭提示",
    saving: "保存中…",
    discard: "放弃更改",
    unsavedChanges: "有未保存的更改",
    allChangesSaved: "所有更改均已保存",
    notPersisted: "当前设置不会被持久化",
    unsavedConfirmation: "当前设置尚未保存。确定离开这个分区吗？",
    persistenceUnavailableTitle: "设置持久化不可用",
    persistenceUnavailableMessage:
      "当前环境无法读取或写入 Owner 设置。所有可写设置控件已禁用，页面不会把临时值伪装成已保存状态。",
  },
  en: {
    pageTitle: "Manage your account, security entry point, and Dashboard alerts.",
    pageDescription:
      "These settings belong to the current Owner. They do not change any representative identity, knowledge, pricing, or published version.",
    sectionNavigationLabel: "Settings sections",
    profileTab: "Profile & preferences",
    securityTab: "Sign-in & security",
    notificationsTab: "Notifications",
    profileEyebrow: "Owner profile",
    profileCardTitle: "Account profile",
    profileCardDescription:
      "Your display name identifies the Owner in the control plane and in business records that require a named actor.",
    displayNameLabel: "Display name",
    displayNameHelp:
      "Up to 80 characters. This does not rename a representative or change the public Owner attribution.",
    displayNameRequired: "Enter a display name.",
    displayNameTooLong: "Display name cannot exceed 80 characters.",
    displayNameInvalid: "Enter a valid display name between 1 and 80 characters.",
    preferencesEyebrow: "Preferences",
    preferencesCardTitle: "Region and interface",
    preferencesCardDescription:
      "The time zone controls how business times are displayed. The interface language is the account default; a URL lang parameter can still override it temporarily.",
    timezoneLabel: "Time zone",
    timezoneHelp: "Uses a standard IANA zone and observes daylight saving time.",
    timezoneInvalid: "Choose a valid IANA time zone.",
    invalidStoredTimeZone: (timeZone: string) => `Update required: ${timeZone}`,
    languageLabel: "Default interface language",
    languageHelp: "Applied to future Dashboard visits after saving.",
    languageInvalid: "Choose a supported interface language.",
    profileSavedTitle: "Profile saved",
    profileSavedMessage: "The Owner profile and preferences are up to date.",
    securityEyebrow: "Sign-in identity",
    securityCardTitle: "Login identity",
    securityCardDescription:
      "Delegate shows only current Logto connection data. Passwords, passkeys, and MFA remain managed by the identity provider.",
    providerLabel: "Identity provider",
    connectionLabel: "Connection status",
    emailLabel: "Login email",
    phoneLabel: "Login phone",
    identityVerifiedAtLabel: "Identity last verified",
    connected: "Connected",
    unavailable: "Unavailable",
    notConnected: "Not connected",
    notProvided: "Not provided",
    notAvailable: "Not available",
    verified: "Verified",
    verificationUnknown: "Verification unknown",
    manageLoginSecurity: "Manage login security",
    managementUnavailable:
      "This deployment has no configured Logto self-service security URL. Delegate does not render a non-functional management action.",
    opensNewWindow: "Opens in a new window",
    sessionEyebrow: "Current session",
    sessionCardTitle: "Current browser session",
    sessionCardDescription:
      "The current release can sign out this browser session only. It does not invent a device list or remote-session revocation.",
    currentBrowserSession: "Signed Owner session",
    currentSessionExplanation:
      "Delegate uses a protected browser cookie to maintain this login. Other devices and MFA status remain managed by Logto.",
    sessionUnavailable: "No verifiable Owner session",
    sessionUnavailableExplanation:
      "This environment may be using a local authentication bypass. Delegate does not present it as a signed Logto session.",
    signOutCurrentSession: "Sign out this session",
    notificationsEyebrow: "Dashboard navigation",
    notificationsCardTitle: "Operational alerts",
    notificationsCardDescription:
      "Choose which real pending items enter Dashboard navigation alerts. Disabling a rule never deletes its business records.",
    dashboardNavigationOnly: "Dashboard navigation only",
    dashboardNavigationOnlyDescription:
      "This capability does not send email, SMS, or webhooks, and it has no quiet-hours setting.",
    operationalAlertsLegend: "Alert topics",
    handoffLabel: "Human handoff requests",
    handoffDescription:
      "Show handoffs that remain OPEN or REVIEWING.",
    approvalLabel: "Pending actions",
    approvalDescription:
      "Show approval requests still awaiting an Owner decision.",
    walletExceptionLabel: "Wallet exceptions",
    walletExceptionDescription:
      "Money exceptions always enter alerts and cannot be disabled here.",
    channelFailureLabel: "Channel failures",
    channelFailureDescription:
      "Show publishing channels that should be active but are degraded or unhealthy.",
    switchState: { on: "On", off: "Off", alwaysOn: "Always on" },
    openItems: (count: number) =>
      `${count} ${count === 1 ? "open item" : "open items"}`,
    countUnavailable: "Count unavailable",
    notificationsSavedTitle: "Alerts saved",
    notificationsSavedMessage:
      "Dashboard navigation alert rules are up to date.",
    saveNotifications: "Save alerts",
    saveProfile: "Save profile",
    saveFailedTitle: "Save failed",
    networkErrorMessage:
      "The settings could not be saved. Check the connection and try again.",
    invalidSettingsMessage: "Review the highlighted settings and try again.",
    settingsNotFoundMessage:
      "Settings for this Owner were not found. Refresh the page and try again.",
    persistenceSaveError:
      "Settings storage is temporarily unavailable. Try again later.",
    serverSaveError:
      "The service could not save settings right now. Try again later.",
    saveRejectedMessage:
      "This settings change was not accepted. Refresh the page and try again.",
    sessionExpiredTitle: "Session expired",
    sessionExpiredMessage:
      "Sign in again before saving. Your current input remains on this page.",
    signInAgain: "Sign in again",
    conflictTitle: "Settings changed elsewhere",
    conflictMessage:
      "Another page updated these settings. Your input is still here; reload the latest values before editing again.",
    reloadLatest: "Reload latest",
    dismissFeedback: "Dismiss notice",
    saving: "Saving…",
    discard: "Discard changes",
    unsavedChanges: "Unsaved changes",
    allChangesSaved: "All changes saved",
    notPersisted: "These settings cannot be persisted",
    unsavedConfirmation:
      "These settings have not been saved. Leave this section anyway?",
    persistenceUnavailableTitle: "Settings persistence unavailable",
    persistenceUnavailableMessage:
      "This environment cannot read or write Owner settings. Every writable settings control is disabled and temporary values are not presented as saved state.",
  },
} as const;
