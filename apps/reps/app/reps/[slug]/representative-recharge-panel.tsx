"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";

import { pickCopy, type Locale } from "@delegate/web-ui";

import {
  getCheckoutSecondsRemaining,
  getPublicRechargeStatusPresentation,
  getWeChatPaymentPollDelayMs,
  publishPublicWalletUpdate,
  selectCurrentPublicWalletActivity,
  type PublicCommerceProduct,
  type PublicRechargeOrderStatus,
  type PublicRechargeStatusTone,
  type PublicWalletStateSnapshot,
} from "./public-wallet-client";
import { REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT } from "./representative-profile-rail-events";

type RechargeOrderSnapshot = {
  id: string;
  billingProductId: string | null;
  billingPriceVersionId: string | null;
  productName: string | null;
  productKind: "SERVICE_PACKAGE" | "TIP" | null;
  entitlementUnits: number | null;
  unitName: string | null;
  handoffAllowance: "NONE" | "LIMITED" | "UNLIMITED" | null;
  handoffUnits: number | null;
  handoffServiceLevel: "STANDARD" | "PRIORITY" | null;
  handoffValidityDays: number | null;
  amountCents: number;
  currency: string;
  provider: string;
  status: PublicRechargeOrderStatus;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
};

type TokenPurchaseSnapshot = {
  tokenAmount: number;
  remainingTokenAmount: number;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  currency: string;
};

type PurchaseReversalSnapshot = {
  purchaseId: string;
  tokenAmount: number;
  remainingTokenAmount: number;
  reversedAmountCents: number;
  currency: string;
  status: string;
};

type WeChatPaymentStatus = {
  status: "pending" | "paid" | "closed" | "refunded" | "failed";
  orderStatus?: "created" | "requires_payment";
  providerChecked?: boolean;
  checkoutUrl?: string | null;
  checkoutExpiresAt?: string | null;
};

type PaymentNotice =
  | { kind: "checking"; message: string; tone: "warning" }
  | { kind: "transient"; message: string; tone: "warning" }
  | { kind: "offline"; message: string; tone: "warning" }
  | { kind: "auth"; message: string; tone: "error" }
  | { kind: "manual-review"; message: string; tone: "error" }
  | { kind: "expired-confirming"; message: string; tone: "warning" }
  | { kind: "expired-unconfirmed"; message: string; tone: "warning" }
  | { kind: "expired"; message: string; tone: "warning" }
  | { kind: "paid-refreshing"; message: string; tone: "success" }
  | { kind: "paid-refresh-failed"; message: string; tone: "warning" }
  | { kind: "paid"; message: string; tone: "success" };

type RechargeMutation = "create" | null;

type RechargeIntent = {
  priceVersionId: string;
  idempotencyKey: string;
};

export function RepresentativeRechargePanel({
  audienceAuthenticated,
  collectionEnabled,
  continuationChannel,
  initialCommerceProducts,
  loginHref,
  representativeSlug,
  locale,
  paymentAvailability,
}: {
  audienceAuthenticated: boolean;
  collectionEnabled: boolean;
  continuationChannel?: "telegram";
  initialCommerceProducts: PublicCommerceProduct[];
  loginHref: string;
  representativeSlug: string;
  locale: Locale;
  paymentAvailability: "ready" | "collection_paused" | "unavailable";
}) {
  const t = pickCopy(locale, copy);
  const [commerceProducts, setCommerceProducts] = useState<
    PublicCommerceProduct[]
  >(initialCommerceProducts);
  const [selectedPriceVersionId, setSelectedPriceVersionId] =
    useState<string | null>(
      pickDefaultCommerceProduct(initialCommerceProducts)?.priceVersionId
        ?? null,
    );
  const [order, setOrder] = useState<RechargeOrderSnapshot | null>(null);
  const [purchase, setPurchase] = useState<TokenPurchaseSnapshot | null>(null);
  const [reversal, setReversal] = useState<PurchaseReversalSnapshot | null>(null);
  const [walletState, setWalletState] =
    useState<PublicWalletStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telegramBindingError, setTelegramBindingError] =
    useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isCheckoutUrlCopied, setIsCheckoutUrlCopied] = useState(false);
  const [checkoutClockMs, setCheckoutClockMs] = useState(() => Date.now());
  const [paymentNotice, setPaymentNotice] =
    useState<PaymentNotice | null>(null);
  const [tipCompleted, setTipCompleted] = useState(false);
  const [paymentStatusRetryNonce, setPaymentStatusRetryNonce] =
    useState(0);
  const [mutation, setMutation] = useState<RechargeMutation>(null);
  const mutationLockRef = useRef(false);
  const rechargeIntentRef = useRef<RechargeIntent | null>(null);
  const isMutating = mutation !== null;
  const selectedProduct =
    commerceProducts.find(
      (product) => product.priceVersionId === selectedPriceVersionId,
    ) ?? null;
  const serviceProducts = commerceProducts.filter(
    (product) => product.kind === "SERVICE_PACKAGE",
  );
  const tipProducts = commerceProducts.filter(
    (product) => product.kind === "TIP",
  );
  const requiresTelegramBinding =
    continuationChannel === "telegram"
    && selectedProduct?.kind === "SERVICE_PACKAGE";
  const [telegramBindingStatus, setTelegramBindingStatus] = useState<
    "checking" | "required" | "ready"
  >(
    requiresTelegramBinding && audienceAuthenticated
      ? "checking"
      : requiresTelegramBinding
        ? "required"
        : "ready",
  );

  const refreshTelegramBinding = useCallback(async () => {
    if (!requiresTelegramBinding || !audienceAuthenticated) {
      setTelegramBindingStatus(
        requiresTelegramBinding ? "required" : "ready",
      );
      return;
    }
    setTelegramBindingStatus("checking");
    setTelegramBindingError(null);
    try {
      const response = await fetch(
        `/reps/${representativeSlug}/identity-bindings`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(await extractError(response));
      }
      const payload = (await response.json()) as {
        readiness?: { telegram?: boolean };
      };
      setTelegramBindingStatus(
        payload.readiness?.telegram === true ? "ready" : "required",
      );
    } catch (nextError) {
      setTelegramBindingStatus("required");
      setTelegramBindingError(
        nextError instanceof Error
          ? nextError.message
          : t.bindingCheckError,
      );
    }
  }, [
    audienceAuthenticated,
    representativeSlug,
    requiresTelegramBinding,
    t.bindingCheckError,
  ]);

  useEffect(() => {
    if (requiresTelegramBinding && audienceAuthenticated) {
      void refreshTelegramBinding();
    }
  }, [
    audienceAuthenticated,
    refreshTelegramBinding,
    requiresTelegramBinding,
  ]);

  const rechargeReady =
    audienceAuthenticated
    && (
      !requiresTelegramBinding
      || telegramBindingStatus === "ready"
    );
  const checkoutRemainingSeconds =
    order?.status === "requires_payment"
      ? getCheckoutSecondsRemaining(
          order.checkoutExpiresAt,
          checkoutClockMs,
        )
      : null;
  const isWeChatOrder =
    order?.provider.toLowerCase() === "wechat_pay";
  const checkoutExpired = checkoutRemainingSeconds === 0;
  const paymentResultConfirmed =
    paymentNotice?.kind === "paid-refreshing"
    || paymentNotice?.kind === "paid-refresh-failed"
    || paymentNotice?.kind === "paid";
  const checkoutRequiresManualAction =
    paymentNotice?.kind === "auth"
    || paymentNotice?.kind === "manual-review"
    || paymentNotice?.kind === "expired-confirming"
    || paymentNotice?.kind === "expired-unconfirmed"
    || (
      checkoutExpired
      && paymentNotice?.kind !== "expired"
    );
  const hasActivePendingCheckout =
    isWeChatOrder
    && order?.status === "requires_payment"
    && order.checkoutUrl?.startsWith("weixin://wxpay/") === true
    && !checkoutExpired;
  const hasPendingWeChatOrder =
    isWeChatOrder && order?.status === "requires_payment";
  const hasRecoveringWeChatOrder =
    isWeChatOrder && order?.status === "created";
  const hasActiveWeChatOrder =
    hasRecoveringWeChatOrder || hasPendingWeChatOrder;
  const showWeChatCheckout =
    hasActivePendingCheckout
    && !paymentResultConfirmed
    && !checkoutRequiresManualAction;
  const weChatDisclosureKind =
    hasActiveWeChatOrder || paymentResultConfirmed
      ? order?.productKind ?? selectedProduct?.kind ?? null
      : selectedProduct?.kind ?? order?.productKind ?? null;

  const applyWalletState = useCallback((
    snapshot: PublicWalletStateSnapshot,
  ) => {
    const activity = selectCurrentPublicWalletActivity(snapshot);
    setWalletState(snapshot);
    setOrder(activity.order
      ? {
          id: activity.order.id,
          billingProductId: activity.order.billingProductId,
          billingPriceVersionId: activity.order.billingPriceVersionId,
          productName: activity.order.productName,
          productKind: activity.order.productKind,
          entitlementUnits: activity.order.entitlementUnits,
          unitName: activity.order.unitName,
          handoffAllowance: activity.order.handoffAllowance,
          handoffUnits: activity.order.handoffUnits,
          handoffServiceLevel: activity.order.handoffServiceLevel,
          handoffValidityDays: activity.order.handoffValidityDays,
          amountCents: activity.order.amountCents,
          currency: activity.order.currency,
          provider: activity.order.provider,
          status: activity.order.status,
          checkoutUrl: activity.order.checkoutUrl,
          checkoutExpiresAt: activity.order.checkoutExpiresAt,
        }
      : null);
    setCommerceProducts(snapshot.commerceProducts);
    setTipCompleted(
      activity.order?.productKind === "TIP"
      && activity.order.status === "paid",
    );
    setSelectedPriceVersionId((current) => {
      if (
        current
        && snapshot.commerceProducts.some(
          (product) => product.priceVersionId === current,
        )
      ) {
        return current;
      }
      if (
        activity.order
        && snapshot.commerceProducts.some(
          (product) =>
            product.priceVersionId
            === activity.order?.billingPriceVersionId,
        )
      ) {
        return activity.order.billingPriceVersionId;
      }
      const preferred = pickDefaultCommerceProduct(
        snapshot.commerceProducts,
        snapshot.commerceSettings.accessMode,
      );
      return preferred?.priceVersionId ?? null;
    });
    if (
      (
        activity.order?.status === "created"
        || activity.order?.status === "requires_payment"
      )
      && activity.order.provider === "wechat_pay"
    ) {
      setCheckoutClockMs(Date.now());
    }
    setPurchase(activity.purchase
      ? {
          tokenAmount: activity.purchase.tokenAmount,
          remainingTokenAmount: activity.purchase.remainingTokenAmount,
          availableTokenAmount: snapshot.summary.serviceCreditsAvailable,
          reservedTokenAmount: snapshot.summary.serviceCreditsReserved,
          currency: activity.purchase.currency,
        }
      : null);
    setReversal(activity.refund
      ? {
          purchaseId: activity.refund.purchaseId,
          tokenAmount: activity.refund.tokenAmount,
          remainingTokenAmount:
            activity.purchase?.remainingTokenAmount ?? 0,
          reversedAmountCents: activity.refund.amountCents,
          currency: activity.refund.currency,
          status: activity.refund.status,
        }
      : null);
    if (activity.order?.productKind !== "TIP") {
      publishPublicWalletUpdate({
        representativeSlug,
        serviceCreditsAvailable: snapshot.summary.serviceCreditsAvailable,
        serviceCreditsReserved: snapshot.summary.serviceCreditsReserved,
        serviceCreditsPurchased: snapshot.summary.serviceCreditsPurchased,
        handoffEntitlement: snapshot.handoffEntitlement,
      });
    }
  }, [representativeSlug]);

  const refreshWalletState = useCallback(async (
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      `/reps/${representativeSlug}/recharge?currency=CNY`,
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(await extractError(response));
    }
    const snapshot = (await response.json()) as PublicWalletStateSnapshot;
    applyWalletState(snapshot);
  }, [applyWalletState, representativeSlug]);

  useEffect(() => {
    if (!audienceAuthenticated) {
      setIsRestoring(false);
      setWalletState(null);
      return;
    }
    const controller = new AbortController();
    setIsRestoring(true);
    void refreshWalletState(controller.signal)
      .catch((nextError: unknown) => {
        if (
          nextError instanceof DOMException
          && nextError.name === "AbortError"
        ) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : t.loadError);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsRestoring(false);
        }
      });
    return () => controller.abort();
  }, [audienceAuthenticated, refreshWalletState, t.loadError]);

  useEffect(() => {
    if (
      paymentAvailability === "unavailable"
      || !order?.id
      || order.provider.toLowerCase() !== "wechat_pay"
      || (
        order.status !== "created"
        && order.status !== "requires_payment"
      )
    ) {
      return;
    }
    const orderId = order.id;
    const checkoutExpiresAt = order.checkoutExpiresAt;
    let stopped = false;
    let attempt = 0;
    let timer: number | null = null;
    let requestController: AbortController | null = null;
    let walletRefreshController: AbortController | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const isPageReady = () =>
      document.visibilityState !== "hidden"
      && (typeof navigator === "undefined" || navigator.onLine !== false);
    const hasExpired = () =>
      getCheckoutSecondsRemaining(checkoutExpiresAt, Date.now()) === 0;
    const markExpiryConfirmed = () => {
      setCheckoutClockMs(Date.now());
      setPaymentNotice({
        kind: "expired-confirming",
        message: t.wechatExpiredConfirmed,
        tone: "warning",
      });
      schedule();
    };
    const markExpiryUnconfirmed = () => {
      setCheckoutClockMs(Date.now());
      setPaymentNotice({
        kind: "expired-unconfirmed",
        message: t.wechatExpiredUnconfirmed,
        tone: "warning",
      });
      schedule();
    };
    const schedule = () => {
      clearTimer();
      if (stopped || !isPageReady()) {
        return;
      }
      const delay = getWeChatPaymentPollDelayMs(attempt);
      attempt += 1;
      const remainingMs = checkoutExpiresAt
        ? Math.max(0, Date.parse(checkoutExpiresAt) - Date.now())
        : null;
      timer = window.setTimeout(
        () => void reconcile(),
        remainingMs === null
          ? delay
          : remainingMs === 0
            ? delay
            : Math.max(250, Math.min(delay, remainingMs)),
      );
    };
    const reconcile = async () => {
      if (stopped || requestController || !isPageReady()) {
        return;
      }
      const isFinalExpiryCheck = hasExpired();
      if (isFinalExpiryCheck) {
        setCheckoutClockMs(Date.now());
        setPaymentNotice({
          kind: "expired-confirming",
          message: t.wechatExpiredConfirming,
          tone: "warning",
        });
      }
      const controller = new AbortController();
      requestController = controller;
      try {
        const response = await fetch(
          `/reps/${representativeSlug}/recharge/${orderId}/wechat-status`,
          {
            method: "POST",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          const message = await extractError(response);
          if (response.status === 401) {
            stopped = true;
            setPaymentNotice({
              kind: "auth",
              message: t.wechatAuthExpired,
              tone: "error",
            });
            return;
          }
          if (response.status === 409) {
            stopped = true;
            setPaymentNotice({
              kind: "manual-review",
              message: t.wechatManualReview,
              tone: "error",
            });
            return;
          }
          if (response.status === 502 || response.status === 503) {
            if (isFinalExpiryCheck) {
              markExpiryUnconfirmed();
              return;
            }
            setPaymentNotice({
              kind: "transient",
              message: `${t.wechatProviderRetry} ${message}`,
              tone: "warning",
            });
            schedule();
            return;
          }
          if (isFinalExpiryCheck) {
            markExpiryUnconfirmed();
            return;
          }
          setPaymentNotice({
            kind: "transient",
            message: message || t.wechatStatusRetry,
            tone: "warning",
          });
          schedule();
          return;
        }
        const result = (await response.json()) as WeChatPaymentStatus;
        if (result.status === "paid") {
          stopped = true;
          clearTimer();
          setPaymentNotice({
            kind: "paid-refreshing",
            message: t.wechatPaidRefreshing(order.productKind),
            tone: "success",
          });
          walletRefreshController = new AbortController();
          try {
            await refreshWalletState(walletRefreshController.signal);
            setPaymentNotice({
              kind: "paid",
              message: t.wechatPaid(order.productKind),
              tone: "success",
            });
          } catch (nextError) {
            if (!isAbortError(nextError)) {
              setPaymentNotice({
                kind: "paid-refresh-failed",
                message: t.wechatPaidRefreshFailed(order.productKind),
                tone: "warning",
              });
            }
          } finally {
            walletRefreshController = null;
          }
          return;
        }
        if (result.status === "pending") {
          if (result.orderStatus === "created") {
            setPaymentNotice({
              kind: "checking",
              message: t.wechatRecovering,
              tone: "warning",
            });
            schedule();
            return;
          }
          if (
            result.orderStatus === "requires_payment"
            && typeof result.checkoutUrl === "string"
            && result.checkoutUrl.startsWith("weixin://wxpay/")
          ) {
            const nextCheckoutExpiresAt =
              typeof result.checkoutExpiresAt === "string"
                ? result.checkoutExpiresAt
                : null;
            const checkoutRecovered =
              order.status !== "requires_payment"
              || order.checkoutUrl !== result.checkoutUrl
              || order.checkoutExpiresAt !== nextCheckoutExpiresAt;
            setOrder((current) => current?.id === orderId
              ? {
                  ...current,
                  status: "requires_payment",
                  checkoutUrl: result.checkoutUrl ?? null,
                  checkoutExpiresAt: nextCheckoutExpiresAt,
                }
              : current);
            setCheckoutClockMs(Date.now());
            if (checkoutRecovered) {
              setPaymentNotice({
                kind: "checking",
                message: t.wechatAwaitingPayment,
                tone: "warning",
              });
              return;
            }
          }
          if (isFinalExpiryCheck || hasExpired()) {
            if (result.providerChecked === true) {
              markExpiryConfirmed();
            } else {
              markExpiryUnconfirmed();
            }
            return;
          }
          setPaymentNotice({
            kind: "checking",
            message: t.wechatAwaitingPayment,
            tone: "warning",
          });
          schedule();
          return;
        }
        stopped = true;
        const terminalStatus: PublicRechargeOrderStatus =
          result.status === "closed"
            ? "canceled"
            : result.status === "refunded"
              ? "refunded"
              : "failed";
        setPaymentNotice(null);
        setOrder((current) => current?.id === orderId
          ? {
              ...current,
              status: terminalStatus,
              checkoutUrl: null,
              checkoutExpiresAt: null,
            }
          : current);
      } catch (nextError) {
        if (!isAbortError(nextError)) {
          if (isFinalExpiryCheck) {
            markExpiryUnconfirmed();
            return;
          }
          setPaymentNotice({
            kind:
              typeof navigator !== "undefined" && navigator.onLine === false
                ? "offline"
                : "transient",
            message:
              typeof navigator !== "undefined" && navigator.onLine === false
                ? t.wechatOffline
                : t.wechatStatusRetry,
            tone: "warning",
          });
          schedule();
        }
      } finally {
        if (requestController === controller) {
          requestController = null;
        }
      }
    };

    const pauseOrResume = () => {
      clearTimer();
      requestController?.abort();
      requestController = null;
      if (stopped) {
        return;
      }
      if (!isPageReady()) {
        if (
          typeof navigator !== "undefined"
          && navigator.onLine === false
        ) {
          setPaymentNotice({
            kind: "offline",
            message: t.wechatOffline,
            tone: "warning",
          });
        }
        return;
      }
      attempt = 0;
      timer = window.setTimeout(() => void reconcile(), 0);
    };

    void reconcile();
    document.addEventListener("visibilitychange", pauseOrResume);
    window.addEventListener("online", pauseOrResume);
    window.addEventListener("offline", pauseOrResume);
    return () => {
      stopped = true;
      clearTimer();
      requestController?.abort();
      walletRefreshController?.abort();
      document.removeEventListener("visibilitychange", pauseOrResume);
      window.removeEventListener("online", pauseOrResume);
      window.removeEventListener("offline", pauseOrResume);
    };
  }, [
    order?.checkoutExpiresAt,
    order?.checkoutUrl,
    order?.id,
    order?.productKind,
    order?.provider,
    order?.status,
    paymentStatusRetryNonce,
    paymentAvailability,
    refreshWalletState,
    representativeSlug,
    t.wechatAuthExpired,
    t.wechatAwaitingPayment,
    t.wechatExpiredDetail,
    t.wechatExpiredConfirmed,
    t.wechatExpiredConfirming,
    t.wechatExpiredUnconfirmed,
    t.wechatManualReview,
    t.wechatOffline,
    t.wechatPaid,
    t.wechatPaidRefreshFailed,
    t.wechatPaidRefreshing,
    t.wechatProviderRetry,
    t.wechatRecovering,
    t.wechatStatusRetry,
  ]);

  useEffect(() => {
    if (
      order?.status !== "requires_payment"
      || !order.checkoutExpiresAt
    ) {
      return;
    }
    let timer: number | null = null;
    const tick = () => {
      const now = Date.now();
      setCheckoutClockMs(now);
      const seconds = getCheckoutSecondsRemaining(
        order.checkoutExpiresAt,
        now,
      );
      if (seconds !== null && seconds > 0) {
        timer = window.setTimeout(tick, 1_000);
      }
    };
    tick();
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    order?.checkoutExpiresAt,
    order?.status,
  ]);

  async function restoreAfterMutation() {
    try {
      await refreshWalletState();
    } catch {
      setError(t.refreshError);
    }
  }

  function createRechargeOrder() {
    if (
      !collectionEnabled
      || !rechargeReady
      || hasActiveWeChatOrder
      || paymentResultConfirmed
      || checkoutRequiresManualAction
      || !selectedPriceVersionId
      || !beginMutation("create")
    ) {
      return;
    }
    setError(null);
    setPaymentNotice(null);
    const existingIntent = rechargeIntentRef.current;
    const intent =
      existingIntent?.priceVersionId === selectedPriceVersionId
        ? existingIntent
        : {
            priceVersionId: selectedPriceVersionId,
            idempotencyKey: randomId(),
          };
    rechargeIntentRef.current = intent;
    void (async () => {
        const response = await fetch(`/reps/${representativeSlug}/recharge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            billingPriceVersionId: intent.priceVersionId,
            idempotencyKey: intent.idempotencyKey,
            ...(continuationChannel
              && selectedProduct?.kind === "SERVICE_PACKAGE"
              ? { continuationChannel }
              : {}),
          }),
        });

        const payload = (await response.json().catch(() => null)) as {
          rechargeOrder?: RechargeOrderSnapshot;
          code?: string;
          error?: string;
        } | null;
        if (!response.ok) {
          if (
            response.status === 409
            && payload?.code === "payment_checkout_active"
            && payload.rechargeOrder
          ) {
            setOrder(payload.rechargeOrder);
            setSelectedPriceVersionId(
              payload.rechargeOrder.billingPriceVersionId,
            );
            setCheckoutClockMs(Date.now());
            setPaymentNotice({
              kind: "checking",
              message:
                payload.rechargeOrder.status === "created"
                  ? t.wechatRecovering
                  : t.wechatExistingCheckoutRestored,
              tone: "warning",
            });
          }
          throw new Error(
            payload?.error ?? response.statusText,
          );
        }
        if (!payload?.rechargeOrder) {
          throw new Error(t.createError);
        }
        setOrder(payload.rechargeOrder);
        setSelectedPriceVersionId(
          payload.rechargeOrder.billingPriceVersionId,
        );
        setCheckoutClockMs(Date.now());
        setIsCheckoutUrlCopied(false);
        setPurchase(null);
        setTipCompleted(false);
        setReversal(null);
        rechargeIntentRef.current = null;
        await restoreAfterMutation();
      })()
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.createError);
      })
      .finally(endMutation);
  }

  function retryPaidWalletRefresh() {
    setPaymentNotice({
      kind: "paid-refreshing",
      message: t.wechatPaidRefreshing(order?.productKind ?? null),
      tone: "success",
    });
    void refreshWalletState()
      .then(() => {
        setPaymentNotice({
          kind: "paid",
          message: t.wechatPaid(order?.productKind ?? null),
          tone: "success",
        });
      })
      .catch(() => {
        setPaymentNotice({
          kind: "paid-refresh-failed",
          message: t.wechatPaidRefreshFailed(order?.productKind ?? null),
          tone: "warning",
        });
      });
  }

  function retryExpiredPaymentStatus() {
    setPaymentNotice({
      kind: "expired-confirming",
      message: t.wechatExpiredConfirming,
      tone: "warning",
    });
    setPaymentStatusRetryNonce((current) => current + 1);
  }

  function copyCheckoutUrl() {
    if (!order?.checkoutUrl) {
      return;
    }
    if (!navigator.clipboard) {
      setError(t.copyError);
      return;
    }
    void navigator.clipboard.writeText(order.checkoutUrl)
      .then(() => setIsCheckoutUrlCopied(true))
      .catch(() => setError(t.copyError));
  }

  function beginMutation(nextMutation: Exclude<RechargeMutation, null>) {
    if (mutationLockRef.current) {
      return false;
    }
    mutationLockRef.current = true;
    setMutation(nextMutation);
    return true;
  }

  function endMutation() {
    mutationLockRef.current = false;
    setMutation(null);
  }

  const orderPresentation = order
    ? getPublicRechargeStatusPresentation(
        order.status,
        locale,
        { checkoutExpired },
      )
    : null;
  const orderTone =
    paymentResultConfirmed
      ? "success"
      : checkoutRequiresManualAction
        ? "error"
        : orderPresentation?.tone ?? "neutral";
  function selectCommerceProduct(product: PublicCommerceProduct) {
    setSelectedPriceVersionId(product.priceVersionId);
    setTipCompleted(false);
    if (
      rechargeIntentRef.current
      && rechargeIntentRef.current.priceVersionId !== product.priceVersionId
    ) {
      rechargeIntentRef.current = null;
    }
  }

  return (
    <div className="setup-stack">
      <p className="footer-note">{t.identityNote}</p>

      {paymentAvailability !== "ready" ? (
        <div className="status-banner status-warning" role="status">
          <strong>
            {paymentAvailability === "unavailable"
              ? t.wechatUnavailableTitle
              : t.wechatCollectionPausedTitle}
          </strong>
          <p>
            {paymentAvailability === "unavailable"
              ? t.wechatUnavailableDetail
              : t.wechatCollectionPausedDetail}
          </p>
        </div>
      ) : null}

      {!audienceAuthenticated ? (
        <div className="status-banner">
          <strong>{t.loginRequiredTitle}</strong>
          <p>{t.loginRequiredDetail}</p>
          <a className="button-secondary" href={loginHref}>
            {t.loginAction}
          </a>
        </div>
      ) : null}

      {requiresTelegramBinding && audienceAuthenticated ? (
        <div
          className={
            telegramBindingStatus === "ready"
              ? "status-banner status-success"
              : "status-banner"
          }
        >
          <strong>
            {telegramBindingStatus === "ready"
              ? t.telegramBindingReadyTitle
              : t.telegramBindingRequiredTitle}
          </strong>
          <p>
            {telegramBindingStatus === "ready"
              ? t.telegramBindingReadyDetail
              : t.telegramBindingRequiredDetail}
          </p>
          {telegramBindingStatus !== "ready" ? (
            <div className="button-row">
              <button
                className="button-secondary"
                onClick={(event) => window.dispatchEvent(new CustomEvent(
                  REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT,
                  { detail: { opener: event.currentTarget, section: "bindings" } },
                ))}
                type="button"
              >
                {t.openBindingsAction}
              </button>
              <button
                className="button-secondary"
                disabled={telegramBindingStatus === "checking"}
                onClick={() => void refreshTelegramBinding()}
                type="button"
              >
                {telegramBindingStatus === "checking"
                  ? t.checkingBinding
                  : t.checkBindingAction}
              </button>
            </div>
          ) : null}
          {telegramBindingError ? (
            <p className="feedback-error" role="alert">
              {telegramBindingError}
            </p>
          ) : null}
        </div>
      ) : null}

      {audienceAuthenticated && isRestoring ? (
        <div className="status-banner" role="status">
          <strong>{t.restoring}</strong>
        </div>
      ) : audienceAuthenticated && walletState ? (
        <div className="status-banner" role="status">
          <strong>{t.walletSummaryTitle}</strong>
          <p>
            {t.creditsAvailableLabel}
            {walletState.summary.serviceCreditsAvailable}
            {" · "}
            {t.creditsReservedLabel}
            {walletState.summary.serviceCreditsReserved}
            {" · "}
            {t.creditsConsumedLabel}
            {walletState.summary.serviceCreditsConsumed}
          </p>
          <p className="footer-note">
            {t.recordSummary(
              walletState.orders.length,
              walletState.purchases.length,
              walletState.refunds.length,
            )}
          </p>
        </div>
      ) : null}

      {(!audienceAuthenticated || !isRestoring) && serviceProducts.length > 0 ? (
        <section className="representative-commerce-group" aria-labelledby="representative-service-products-title">
          <div className="representative-commerce-group-heading">
            <strong id="representative-service-products-title">{t.servicePackagesTitle}</strong>
            <span>{t.servicePackagesDetail}</span>
          </div>
          <div className="representative-commerce-options">
            {serviceProducts.map((product) => (
              <button
                aria-pressed={selectedPriceVersionId === product.priceVersionId}
                className={selectedPriceVersionId === product.priceVersionId
                  ? "representative-commerce-option is-selected"
                  : "representative-commerce-option"}
                disabled={isMutating || hasActiveWeChatOrder || paymentResultConfirmed || checkoutRequiresManualAction}
                key={product.priceVersionId}
                onClick={() => selectCommerceProduct(product)}
                type="button"
              >
                <span className="representative-commerce-option-heading">
                  <strong>{product.name}</strong>
                  {product.isRecommended ? <small>{t.recommended}</small> : null}
                </span>
                <b>{formatMoney(product.amountCents, product.currency)}</b>
                {product.description ? <span>{product.description}</span> : null}
                <span className="chip-row">
                  <span className="chip">{t.packageUnits(product.entitlementUnits, product.unitName)}</span>
                  {product.handoffAllowance !== "NONE" ? (
                    <span className="chip chip-safe">{t.handoffBenefit(product)}</span>
                  ) : null}
                </span>
                <small>{t.packagePolicy(product.refundPolicy, product.expiryPolicy)}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {(!audienceAuthenticated || !isRestoring) && tipProducts.length > 0 ? (
        <section className="representative-commerce-group is-tip" aria-labelledby="representative-tip-products-title">
          <div className="representative-commerce-group-heading">
            <strong id="representative-tip-products-title">{t.tipProductsTitle}</strong>
            <span>{t.tipProductsDetail}</span>
          </div>
          <div className="representative-commerce-options">
            {tipProducts.map((product) => (
              <button
                aria-pressed={selectedPriceVersionId === product.priceVersionId}
                className={selectedPriceVersionId === product.priceVersionId
                  ? "representative-commerce-option is-selected"
                  : "representative-commerce-option"}
                disabled={isMutating || hasActiveWeChatOrder || paymentResultConfirmed || checkoutRequiresManualAction}
                key={product.priceVersionId}
                onClick={() => selectCommerceProduct(product)}
                type="button"
              >
                <span className="representative-commerce-option-heading">
                  <strong>{product.name}</strong>
                  {product.isRecommended ? <small>{t.recommended}</small> : null}
                </span>
                <b>{formatMoney(product.amountCents, product.currency)}</b>
                {product.description ? <span>{product.description}</span> : null}
                <small>{t.tipPolicy}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {audienceAuthenticated
        && (commerceProducts.length > 0 || hasActiveWeChatOrder) ? (
          <button
            className="button-primary button-block"
            disabled={
              !collectionEnabled
              || isMutating
              || isRestoring
              || !rechargeReady
              || !selectedPriceVersionId
              || hasActiveWeChatOrder
              || paymentResultConfirmed
              || checkoutRequiresManualAction
            }
            onClick={createRechargeOrder}
            type="button"
          >
            {mutation === "create"
              ? t.creating
              : paymentAvailability === "unavailable"
                ? t.wechatUnavailableAction
                : !collectionEnabled
                  ? t.wechatCollectionPausedAction
                : checkoutExpired
                  ? checkoutRequiresManualAction
                    ? t.wechatExpiryConfirmationAction
                    : t.regenerateWechatAction
                  : hasRecoveringWeChatOrder
                    ? t.wechatRecoveringAction
                  : hasActivePendingCheckout
                    ? t.wechatPendingAction
                    : selectedProduct?.kind === "TIP"
                      ? t.wechatTipAction
                      : t.wechatCreateAction}
          </button>
        ) : null}
      {hasActiveWeChatOrder ? (
        <p className="footer-note representative-payment-action-note">
          {hasRecoveringWeChatOrder
            ? t.wechatRecoveringPreventsDuplicate
            : checkoutExpired
              ? t.wechatExpiredPreventsDuplicate
              : t.wechatPendingPreventsDuplicate}
        </p>
      ) : null}

      {order ? (
        <div
          className={`status-banner ${statusToneClassName(orderTone)}`}
        >
          <strong>{t.latestOrder}</strong>
          <p>
            {order.productName ?? t.legacyCommerceProduct}
            {" · "}
            {formatMoney(order.amountCents, order.currency)}
            {" · "}
            <span className="representative-payment-status">
              {paymentResultConfirmed
                ? t.paymentConfirmedStatus
                : orderPresentation?.label}
            </span>
            {" · "}
            {order.productKind === "TIP"
              ? t.tipOrderTerms
              : order.entitlementUnits && order.unitName
              ? t.packageUnits(order.entitlementUnits, order.unitName)
              : t.legacyOrderTerms}
          </p>
          {order.status === "requires_payment"
            && showWeChatCheckout
            && order.checkoutUrl ? (
              <div className="representative-wechat-checkout">
                <QRCodeSVG
                  bgColor="#FFFFFF"
                  fgColor="#111827"
                  includeMargin
                  level="M"
                  size={216}
                  title={t.wechatQrTitle}
                  value={order.checkoutUrl}
                />
                <div>
                  <strong>{t.wechatQrTitle}</strong>
                  <p>{t.wechatQrDetail(order.productKind)}</p>
                  {checkoutRemainingSeconds !== null ? (
                    <p
                      className="representative-wechat-countdown"
                      role="timer"
                    >
                      {t.wechatCountdown(
                        formatCountdown(checkoutRemainingSeconds),
                      )}
                    </p>
                  ) : null}
                  <div className="button-row">
                    <a
                      className="button-primary"
                      href={order.checkoutUrl}
                    >
                      {t.openWechatAction}
                    </a>
                    <button
                      className="button-secondary"
                      onClick={copyCheckoutUrl}
                      type="button"
                    >
                      {isCheckoutUrlCopied
                        ? t.checkoutUrlCopied
                        : t.copyCheckoutUrl}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          {checkoutExpired ? (
            <p className="representative-payment-expired">
              {paymentNotice?.kind !== "expired"
                ? t.wechatExpiredConfirming
                : t.wechatExpiredDetail}
            </p>
          ) : null}
          {order.productKind === "TIP" && (tipCompleted || order.status === "paid") ? (
            <p className="representative-tip-thanks" role="status">
              <strong>{t.tipThanksTitle}</strong>
              {" "}{t.tipThanksDetail}
            </p>
          ) : null}
          {purchase ? (
            <>
              <p>
                {t.creditsLabel}
                <strong>{purchase.availableTokenAmount}</strong>
                {" · "}
                {t.creditsScope}
              </p>
              {purchase.reservedTokenAmount > 0 ? (
                <p className="footer-note">{t.reservedReturnHint}</p>
              ) : null}
            </>
          ) : null}
          {reversal ? (
            <p>
              <strong>{t.returnedTitle}</strong>
              {" · "}
              {t.returnedDetail(
                reversal.tokenAmount,
                reversal.reversedAmountCents,
                reversal.currency,
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {paymentNotice ? (
        <div
          className={`status-banner ${statusToneClassName(paymentNotice.tone)}`}
          role={paymentNotice.tone === "error" ? "alert" : "status"}
        >
          <strong>{paymentNotice.message}</strong>
          {paymentNotice.kind === "auth" ? (
            <a className="button-secondary" href={loginHref}>
              {t.loginAction}
            </a>
          ) : null}
          {paymentNotice.kind === "manual-review" ? (
            <p>{t.wechatManualReviewAction}</p>
          ) : null}
          {paymentNotice.kind === "paid-refresh-failed" ? (
            <button
              className="button-secondary"
              disabled={mutation !== null}
              onClick={retryPaidWalletRefresh}
              type="button"
            >
              {t.refreshWalletAction}
            </button>
          ) : null}
          {paymentNotice.kind === "expired-unconfirmed" ? (
            <button
              className="button-secondary"
              onClick={retryExpiredPaymentStatus}
              type="button"
            >
              {t.retryPaymentStatusAction}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="status-banner status-error" role="alert">{error}</div> : null}
      <p className="footer-note">
        {t.wechatDisclaimer(weChatDisclosureKind)}
      </p>
    </div>
  );
}

async function extractError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

function pickDefaultCommerceProduct(
  products: PublicCommerceProduct[],
  accessMode: PublicWalletStateSnapshot["commerceSettings"]["accessMode"] =
    "TRIAL_THEN_CREDITS",
) {
  const serviceProducts = products.filter(
    (product) => product.kind === "SERVICE_PACKAGE",
  );
  const tips = products.filter((product) => product.kind === "TIP");
  const preferredProducts = accessMode === "FREE" ? tips : serviceProducts;
  return preferredProducts.find((product) => product.isRecommended)
    ?? preferredProducts[0]
    ?? tips.find((product) => product.isRecommended)
    ?? tips[0]
    ?? null;
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function formatCountdown(seconds: number): string {
  const normalized = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(normalized / 60);
  const remainingSeconds = normalized % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function statusToneClassName(tone: PublicRechargeStatusTone): string {
  switch (tone) {
    case "success":
      return "status-success";
    case "warning":
      return "status-warning";
    case "error":
      return "status-error";
    case "neutral":
      return "status-neutral";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const copy = {
  zh: {
    identityNote: "服务套餐和自愿支持都会记入当前已登录的 Delegate 账户。套餐额度与人工权益仅适用于当前数字代表；打赏不赠送额度或人工权益。",
    restoring: "正在读取当前代表的服务与支持选项…",
    loadError: "服务与支持选项读取失败。",
    refreshError: "操作已完成，但最新服务额度暂时无法刷新，请重新加载页面。",
    walletSummaryTitle: "当前代表的服务额度",
    creditsAvailableLabel: "可用额度 ",
    creditsReservedLabel: "预留额度 ",
    creditsConsumedLabel: "已消费额度 ",
    recordSummary: (orders: number, purchases: number, refunds: number) =>
      `最近记录：${orders} 笔订单 · ${purchases} 次额度发放 · ${refunds} 笔退款`,
    loginRequiredTitle: "请先登录 Delegate 账户",
    loginRequiredDetail: "服务与支持订单会记入已登录账户，不会记入临时浏览器身份；只有服务套餐会增加额度或人工权益。",
    loginAction: "登录 / 注册",
    telegramBindingRequiredTitle: "请先绑定当前 Telegram 账户",
    telegramBindingRequiredDetail: "在上方“跨渠道身份”生成 /bind 命令，发送给当前 Bot 后再回来检查。",
    telegramBindingReadyTitle: "Telegram 身份已绑定",
    telegramBindingReadyDetail: "购买后，当前代表的服务额度可由已绑定的 Telegram 账户使用。",
    openBindingsAction: "打开身份绑定",
    checkBindingAction: "重新检查",
    checkingBinding: "检查中...",
    bindingCheckError: "Telegram 绑定状态检查失败。",
    servicePackagesTitle: "选择当前数字代表的服务包",
    servicePackagesDetail: "套餐会发放当前代表专属额度；标注的人工接管权益同时生效。",
    tipProductsTitle: "自愿支持",
    tipProductsDetail: "可选择不同金额表达支持；这不是购买服务，也不改变响应优先级。",
    recommended: "推荐",
    packageUnits: (units: number, unitName: string) =>
      `${units} ${unitName === "credit" ? "服务额度" : unitName || "服务额度"}`,
    packagePolicy: (refundPolicy: string, expiryPolicy: string) =>
      `${refundPolicy === "FULL_WHEN_UNUSED" ? "完全未使用时可申请全额退款" : "按商品退款规则处理"} · ${expiryPolicy === "NEVER_EXPIRES" ? "长期有效" : "按商品有效期使用"}`,
    handoffBenefit: (product: Extract<PublicCommerceProduct, { kind: "SERVICE_PACKAGE" }>) => {
      const allowance = product.handoffAllowance === "UNLIMITED"
        ? "不限次人工"
        : `${product.handoffUnits ?? 0} 次人工`;
      return `${allowance}${product.handoffServiceLevel === "PRIORITY" ? " · 优先" : " · 标准"}${product.handoffValidityDays ? ` · ${product.handoffValidityDays} 天` : ""}`;
    },
    tipPolicy: "自愿支持 · 不赠服务额度 · 不含人工接管 · 不可退款",
    wechatCreateAction: "使用微信购买所选服务包",
    wechatTipAction: "使用微信自愿支持",
    wechatUnavailableTitle: "微信支付暂不可用",
    wechatUnavailableDetail: "支付配置尚未就绪，当前不会创建订单或切换到模拟支付。请稍后再试。",
    wechatUnavailableAction: "支付暂不可用",
    wechatCollectionPausedTitle: "微信支付已暂停新收款",
    wechatCollectionPausedDetail: "当前不能生成新的支付二维码；已创建订单仍会继续查询和入账，请按现有二维码完成支付或等待结果确认。",
    wechatCollectionPausedAction: "新收款已暂停",
    regenerateWechatAction: "重新生成微信支付二维码",
    wechatExpiryConfirmationAction: "正在确认到期订单",
    wechatRecoveringAction: "正在安全恢复微信支付订单",
    wechatPendingAction: "请完成当前待支付订单",
    wechatRecoveringPreventsDuplicate: "正在确认上一次微信下单结果。二维码生成后会自动显示；为避免生成两笔可支付订单，请勿重复创建。",
    wechatPendingPreventsDuplicate: "当前二维码仍在有效期内。为避免重复扣款，请先完成或等待该订单关闭。",
    wechatExpiredPreventsDuplicate: "当前二维码已过期，但旧订单尚未由微信确认关闭。系统会继续查询并安全关单；关闭前请勿创建第二笔订单。",
    creating: "处理中...",
    createError: "创建商品订单失败。",
    latestOrder: "最近一笔订单",
    legacyCommerceProduct: "历史服务订单",
    legacyOrderTerms: "历史订单未保存商品快照",
    tipOrderTerms: "自愿支持 · 不赠额度或人工权益 · 不可退款",
    tipThanksTitle: "感谢你的支持。",
    tipThanksDetail: "本次支持已确认，不会增加服务额度，也不会创建退款额度按钮。",
    wechatQrTitle: "微信扫码支付",
    wechatQrDetail: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "请使用微信扫描二维码。支付成功后会记录本次自愿支持，不发放服务额度或人工权益。" : "请使用微信扫描二维码。支付成功后，所选服务额度和人工权益会直接发放给当前数字代表。",
    wechatCountdown: (time: string) => `二维码剩余有效时间 ${time}`,
    wechatAwaitingPayment: "正在等待微信支付确认。",
    wechatRecovering: "微信支付订单正在安全确认，二维码生成后会自动显示。",
    wechatExpiredDetail: "当前二维码已过期，不会再展示。请重新生成后再扫码支付。",
    wechatExpiredConfirming: "二维码已到期，正在做最后一次支付结果确认。确认完成前请勿重复支付。",
    wechatExpiredConfirmed: "二维码已到期，暂未发现成功支付；系统正在等待微信安全关闭旧订单，关闭前请勿创建新订单。",
    wechatExpiredUnconfirmed: "二维码已到期，但支付结果暂时无法确认。请勿重复支付；系统会继续查询。",
    retryPaymentStatusAction: "重新查询支付结果",
    wechatAuthExpired: "登录状态已失效，支付查询已停止。请重新登录后核对订单。",
    wechatManualReview: "支付结果与当前订单需要人工核对，自动查询已停止。",
    wechatManualReviewAction: "请勿重复支付。联系数字代表主人并提供当前订单时间和金额进行核对。",
    wechatProviderRetry: "微信支付状态暂时不可用，本页会降低频率后自动重试。",
    wechatStatusRetry: "网络暂时不可用，本页会自动重试支付状态。",
    wechatOffline: "当前设备已离线；支付查询已暂停，恢复联网后会自动继续。",
    wechatPaidRefreshing: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "微信支付已确认，正在刷新支持记录…" : "微信支付已确认，正在刷新当前代表的服务权益…",
    wechatPaid: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "微信支付已确认，感谢你的自愿支持。" : "微信支付已确认，当前代表的服务权益已发放。",
    wechatPaidRefreshFailed: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "微信支付已确认，但支持记录暂时无法刷新。请勿重复支付。" : "微信支付已确认，但服务权益暂时无法刷新。请勿重复支付，可重新读取。",
    wechatExistingCheckoutRestored: "已恢复仍在有效期内的待支付二维码。",
    paymentConfirmedStatus: "支付已确认",
    refreshWalletAction: "重新读取服务额度",
    openWechatAction: "在微信中打开",
    copyCheckoutUrl: "复制支付链接",
    checkoutUrlCopied: "已复制",
    copyError: "支付链接复制失败，请直接扫描二维码。",
    creditsLabel: "当前代表可用服务额度 ",
    creditsScope: "仅限当前数字代表",
    reservedReturnHint: "有额度正在服务请求中，结算或释放后才能退回。",
    returnedTitle: "退款已处理",
    returnedDetail: (
      tokens: number,
      amountCents: number,
      currency: string,
    ) => `${tokens} 额度 · ${formatMoney(amountCents, currency)}`,
    wechatDisclaimer: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "当前使用微信 Native 支付。Delegate 只保存订单和验签后的最小支付凭据，不接触微信支付密码；自愿支持不赠送服务权益，支付确认后不可退款。" : "当前使用微信 Native 支付。Delegate 只保存订单和验签后的最小支付凭据，不接触微信支付密码；支付成功后会发放当前数字代表专属服务权益，退款按所购套餐规则处理。",
  },
  en: {
    identityNote: "Service packages and voluntary support are recorded on the signed-in Delegate account. Package credits and human-help entitlements apply only to this representative; tips include neither.",
    restoring: "Loading services and support options for this representative…",
    loadError: "Services and support options could not be loaded.",
    refreshError: "The operation completed, but the latest service credits could not be refreshed. Reload the page to try again.",
    walletSummaryTitle: "Credits for this representative",
    creditsAvailableLabel: "available credits ",
    creditsReservedLabel: "reserved credits ",
    creditsConsumedLabel: "consumed credits ",
    recordSummary: (orders: number, purchases: number, refunds: number) =>
      `Recent records: ${orders} orders · ${purchases} credit grants · ${refunds} refunds`,
    loginRequiredTitle: "Sign in to your Delegate account",
    loginRequiredDetail: "Services-and-support orders are attached to a signed-in account, never a temporary browser identity. Only service packages add credits or human-help entitlements.",
    loginAction: "Sign in / register",
    telegramBindingRequiredTitle: "Link this Telegram account first",
    telegramBindingRequiredDetail: "Create a /bind command in Cross-channel identity above, send it to this Bot, then check again.",
    telegramBindingReadyTitle: "Telegram identity linked",
    telegramBindingReadyDetail: "Credits purchased here can be used for this representative by the linked Telegram account.",
    openBindingsAction: "Open identity linking",
    checkBindingAction: "Check again",
    checkingBinding: "Checking...",
    bindingCheckError: "Unable to check the Telegram identity link.",
    servicePackagesTitle: "Choose a service package for this representative",
    servicePackagesDetail: "Packages grant representative-scoped credits and any human-takeover entitlement shown below.",
    tipProductsTitle: "Voluntary support",
    tipProductsDetail: "Choose an amount to show support. This is not a service purchase and does not change response priority.",
    recommended: "Recommended",
    packageUnits: (units: number, unitName: string) =>
      `${units} ${
        unitName === "credit"
          ? units === 1
            ? "service credit"
            : "service credits"
          : unitName || "service credits"
      }`,
    packagePolicy: (refundPolicy: string, expiryPolicy: string) =>
      `${refundPolicy === "FULL_WHEN_UNUSED" ? "Full refund available while completely unused" : "Product refund policy applies"} · ${expiryPolicy === "NEVER_EXPIRES" ? "Does not expire" : "Product expiry policy applies"}`,
    handoffBenefit: (product: Extract<PublicCommerceProduct, { kind: "SERVICE_PACKAGE" }>) => {
      const allowance = product.handoffAllowance === "UNLIMITED"
        ? "Unlimited human help"
        : `${product.handoffUnits ?? 0} human takeover${product.handoffUnits === 1 ? "" : "s"}`;
      return `${allowance}${product.handoffServiceLevel === "PRIORITY" ? " · priority" : " · standard"}${product.handoffValidityDays ? ` · ${product.handoffValidityDays} days` : ""}`;
    },
    tipPolicy: "Voluntary · no service credits · no human takeover · non-refundable",
    wechatCreateAction: "Buy selected package with WeChat Pay",
    wechatTipAction: "Support with WeChat Pay",
    wechatUnavailableTitle: "WeChat Pay is temporarily unavailable",
    wechatUnavailableDetail: "Payment configuration is not ready. No order will be created and checkout will not fall back to a simulated payment. Try again later.",
    wechatUnavailableAction: "Payment unavailable",
    wechatCollectionPausedTitle: "New WeChat Pay collection is paused",
    wechatCollectionPausedDetail: "New QR codes cannot be created right now. Existing orders will still be checked and credited; complete the current checkout or wait for its result.",
    wechatCollectionPausedAction: "New collection paused",
    regenerateWechatAction: "Generate a new WeChat Pay QR",
    wechatExpiryConfirmationAction: "Confirming expired order",
    wechatRecoveringAction: "Recovering WeChat Pay order",
    wechatPendingAction: "Complete the pending payment first",
    wechatRecoveringPreventsDuplicate: "The previous WeChat Pay creation is being verified. Its QR will appear automatically; do not create another payable order.",
    wechatPendingPreventsDuplicate: "This QR code is still valid. Complete it or wait for the order to close before creating another, avoiding a duplicate charge.",
    wechatExpiredPreventsDuplicate: "This QR code expired, but WeChat has not confirmed the old order closed. Checks and safe closure will continue; do not create a second order yet.",
    creating: "Working...",
    createError: "Failed to create the order.",
    latestOrder: "Latest order",
    legacyCommerceProduct: "Legacy service order",
    legacyOrderTerms: "Product snapshot unavailable for this legacy order",
    tipOrderTerms: "Voluntary support · no credits or human help · non-refundable",
    tipThanksTitle: "Thank you for your support.",
    tipThanksDetail: "This contribution is confirmed. It does not add service credits or create a return-credits action.",
    wechatQrTitle: "Scan with WeChat Pay",
    wechatQrDetail: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "Scan with WeChat. A successful payment records voluntary support without granting service credits or human help." : "Scan with WeChat. A successful payment directly grants the selected credits and human-help entitlement for this representative.",
    wechatCountdown: (time: string) => `QR code expires in ${time}`,
    wechatAwaitingPayment: "Waiting for WeChat Pay confirmation.",
    wechatRecovering: "The WeChat Pay order is being verified. Its QR code will appear automatically when ready.",
    wechatExpiredDetail: "This QR code has expired and is no longer shown. Generate a new one before paying.",
    wechatExpiredConfirming: "The QR code expired. A final payment-result check is in progress; do not pay again yet.",
    wechatExpiredConfirmed: "The QR code expired and no successful payment is confirmed yet. The old order is being closed safely; do not create a new one yet.",
    wechatExpiredUnconfirmed: "The QR code expired, but its payment result is temporarily unavailable. Do not pay again; checks will continue.",
    retryPaymentStatusAction: "Retry payment status",
    wechatAuthExpired: "Your session expired, so payment checks stopped. Sign in again to verify this order.",
    wechatManualReview: "The payment result and current order need manual review. Automatic checks have stopped.",
    wechatManualReviewAction: "Do not pay again. Contact the representative owner with the order time and amount for verification.",
    wechatProviderRetry: "WeChat Pay status is temporarily unavailable. This page will retry at a lower frequency.",
    wechatStatusRetry: "The network is temporarily unavailable. This page will retry the payment status.",
    wechatOffline: "This device is offline. Payment checks are paused and will resume when the connection returns.",
    wechatPaidRefreshing: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "WeChat Pay is confirmed. Refreshing the support record…" : "WeChat Pay is confirmed. Refreshing this representative's service entitlements…",
    wechatPaid: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "WeChat Pay is confirmed. Thank you for your voluntary support." : "WeChat Pay is confirmed. Service entitlements were issued for this representative.",
    wechatPaidRefreshFailed: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "WeChat Pay is confirmed, but the support record could not refresh yet. Do not pay again." : "WeChat Pay is confirmed, but service entitlements could not refresh yet. Do not pay again; retry the read.",
    wechatExistingCheckoutRestored: "The still-valid pending checkout has been restored.",
    paymentConfirmedStatus: "Payment confirmed",
    refreshWalletAction: "Refresh service credits",
    openWechatAction: "Open in WeChat",
    copyCheckoutUrl: "Copy payment link",
    checkoutUrlCopied: "Copied",
    copyError: "The payment link could not be copied. Please scan the QR code.",
    creditsLabel: "Service credits available for this representative ",
    creditsScope: "scoped to this Digital Representative",
    reservedReturnHint: "Credits reserved by an active service request can be returned after settlement or release.",
    returnedTitle: "Refund processed",
    returnedDetail: (
      tokens: number,
      amountCents: number,
      currency: string,
    ) => `${tokens} credits · ${formatMoney(amountCents, currency)}`,
    wechatDisclaimer: (kind: "SERVICE_PACKAGE" | "TIP" | null) => kind === "TIP" ? "This checkout uses WeChat Pay Native. Delegate stores only the order and minimal verified payment evidence; it never handles a WeChat payment password. Voluntary support grants no service entitlement and is non-refundable once confirmed." : "This checkout uses WeChat Pay Native. Delegate stores only the order and minimal verified payment evidence; it never handles a WeChat payment password. Successful payment grants entitlements for this Digital Representative, and refunds follow the purchased package policy.",
  },
} as const;
