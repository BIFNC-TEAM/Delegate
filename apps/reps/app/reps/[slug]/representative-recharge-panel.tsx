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
  type PublicRechargeOrderStatus,
  type PublicRechargeStatusTone,
  type PublicWalletStateSnapshot,
} from "./public-wallet-client";

type RechargeOrderSnapshot = {
  id: string;
  amountCents: number;
  currency: string;
  provider: string;
  status: PublicRechargeOrderStatus;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  cashBalanceCents: number;
};

type TokenPurchaseSnapshot = {
  id: string;
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
  cashBalanceCents: number;
  currency: string;
  status: string;
};

type UserAgentWalletBalance = {
  availableTokenAmount: number;
  reservedTokenAmount: number;
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

type RechargeMutation = "create" | "mock-pay" | "return" | null;

type RechargeIntent = {
  amountCents: number;
  idempotencyKey: string;
};

export function RepresentativeRechargePanel({
  audienceAuthenticated,
  collectionEnabled,
  continuationChannel,
  loginHref,
  representativeSlug,
  locale,
  paymentMode,
}: {
  audienceAuthenticated: boolean;
  collectionEnabled: boolean;
  continuationChannel?: "telegram";
  loginHref: string;
  representativeSlug: string;
  locale: Locale;
  paymentMode: "mock" | "wechat";
}) {
  const t = pickCopy(locale, copy);
  const [amountCents, setAmountCents] = useState(2000);
  const [order, setOrder] = useState<RechargeOrderSnapshot | null>(null);
  const [purchase, setPurchase] = useState<TokenPurchaseSnapshot | null>(null);
  const [reversal, setReversal] = useState<PurchaseReversalSnapshot | null>(null);
  const [walletState, setWalletState] =
    useState<PublicWalletStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isCheckoutUrlCopied, setIsCheckoutUrlCopied] = useState(false);
  const [checkoutClockMs, setCheckoutClockMs] = useState(() => Date.now());
  const [paymentNotice, setPaymentNotice] =
    useState<PaymentNotice | null>(null);
  const [paymentStatusRetryNonce, setPaymentStatusRetryNonce] =
    useState(0);
  const [mutation, setMutation] = useState<RechargeMutation>(null);
  const mutationLockRef = useRef(false);
  const rechargeIntentRef = useRef<RechargeIntent | null>(null);
  const isMutating = mutation !== null;
  const [telegramBindingStatus, setTelegramBindingStatus] = useState<
    "checking" | "required" | "ready"
  >(
    continuationChannel === "telegram" && audienceAuthenticated
      ? "checking"
      : continuationChannel === "telegram"
        ? "required"
        : "ready",
  );

  const refreshTelegramBinding = useCallback(async () => {
    if (continuationChannel !== "telegram" || !audienceAuthenticated) {
      setTelegramBindingStatus("required");
      return;
    }
    setTelegramBindingStatus("checking");
    setError(null);
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
      setError(
        nextError instanceof Error
          ? nextError.message
          : t.bindingCheckError,
      );
    }
  }, [
    audienceAuthenticated,
    continuationChannel,
    representativeSlug,
    t.bindingCheckError,
  ]);

  useEffect(() => {
    if (continuationChannel === "telegram" && audienceAuthenticated) {
      void refreshTelegramBinding();
    }
  }, [
    audienceAuthenticated,
    continuationChannel,
    refreshTelegramBinding,
  ]);

  const rechargeReady =
    audienceAuthenticated
    && (
      continuationChannel !== "telegram"
      || telegramBindingStatus === "ready"
    );
  const checkoutRemainingSeconds =
    paymentMode === "wechat"
    && order?.status === "requires_payment"
      ? getCheckoutSecondsRemaining(
          order.checkoutExpiresAt,
          checkoutClockMs,
        )
      : null;
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
    paymentMode === "wechat"
    && order?.status === "requires_payment"
    && Boolean(order.checkoutUrl)
    && !checkoutExpired;
  const hasPendingWeChatOrder =
    paymentMode === "wechat"
    && order?.status === "requires_payment";
  const hasRecoveringWeChatOrder =
    paymentMode === "wechat"
    && order?.status === "created";
  const hasActiveWeChatOrder =
    hasRecoveringWeChatOrder || hasPendingWeChatOrder;
  const showWeChatCheckout =
    hasActivePendingCheckout
    && !paymentResultConfirmed
    && !checkoutRequiresManualAction;

  const applyWalletState = useCallback((
    snapshot: PublicWalletStateSnapshot,
  ) => {
    const activity = selectCurrentPublicWalletActivity(snapshot);
    setWalletState(snapshot);
    setOrder(activity.order
      ? {
          id: activity.order.id,
          amountCents: activity.order.amountCents,
          currency: activity.order.currency,
          provider: activity.order.provider,
          status: activity.order.status,
          checkoutUrl: activity.order.checkoutUrl,
          checkoutExpiresAt: activity.order.checkoutExpiresAt,
          cashBalanceCents: snapshot.summary.cashBalanceCents,
        }
      : null);
    if (
      (
        activity.order?.status === "created"
        || activity.order?.status === "requires_payment"
      )
      && activity.order.provider === "wechat_pay"
    ) {
      setAmountCents(activity.order.amountCents);
      setCheckoutClockMs(Date.now());
    }
    setPurchase(activity.purchase
      ? {
          id: activity.purchase.id,
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
          cashBalanceCents: snapshot.summary.cashBalanceCents,
          currency: activity.refund.currency,
          status: activity.refund.status,
        }
      : null);
    publishPublicWalletUpdate({
      representativeSlug,
      serviceCreditsAvailable: snapshot.summary.serviceCreditsAvailable,
      serviceCreditsReserved: snapshot.summary.serviceCreditsReserved,
    });
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
      paymentMode !== "wechat"
      || !order?.id
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
            message: t.wechatPaidRefreshing,
            tone: "success",
          });
          walletRefreshController = new AbortController();
          try {
            await refreshWalletState(walletRefreshController.signal);
            setPaymentNotice({
              kind: "paid",
              message: t.wechatPaid,
              tone: "success",
            });
          } catch (nextError) {
            if (!isAbortError(nextError)) {
              setPaymentNotice({
                kind: "paid-refresh-failed",
                message: t.wechatPaidRefreshFailed,
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
    order?.status,
    paymentStatusRetryNonce,
    paymentMode,
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
      paymentMode !== "wechat"
      || order?.status !== "requires_payment"
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
    paymentMode,
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
      || !beginMutation("create")
    ) {
      return;
    }
    setError(null);
    setPaymentNotice(null);
    const existingIntent = rechargeIntentRef.current;
    const intent =
      existingIntent?.amountCents === amountCents
        ? existingIntent
        : {
            amountCents,
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
            amountCents: intent.amountCents,
            idempotencyKey: intent.idempotencyKey,
            ...(continuationChannel
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
            setAmountCents(payload.rechargeOrder.amountCents);
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
        setCheckoutClockMs(Date.now());
        setIsCheckoutUrlCopied(false);
        setPurchase(null);
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
      message: t.wechatPaidRefreshing,
      tone: "success",
    });
    void refreshWalletState()
      .then(() => {
        setPaymentNotice({
          kind: "paid",
          message: t.wechatPaid,
          tone: "success",
        });
      })
      .catch(() => {
        setPaymentNotice({
          kind: "paid-refresh-failed",
          message: t.wechatPaidRefreshFailed,
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

  function completeMockPayment() {
    if (!order || !beginMutation("mock-pay")) {
      return;
    }
    setError(null);
    void (async () => {
        const response = await fetch(
          `/reps/${representativeSlug}/recharge/${order.id}/mock-success`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              amountCents: order.amountCents,
            }),
          },
        );

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        const payload = (await response.json()) as {
          rechargeOrder: RechargeOrderSnapshot;
          tokenPurchase: TokenPurchaseSnapshot;
        };
        setOrder(payload.rechargeOrder);
        setPurchase(payload.tokenPurchase);
        setReversal(null);
        publishPublicWalletUpdate({
          representativeSlug,
          serviceCreditsAvailable: payload.tokenPurchase.availableTokenAmount,
          serviceCreditsReserved: payload.tokenPurchase.reservedTokenAmount,
        });
        await restoreAfterMutation();
      })()
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.payError);
      })
      .finally(endMutation);
  }

  function returnUnusedCredits() {
    if (
      !order
      || !purchase
      || purchase.remainingTokenAmount <= 0
      || !beginMutation("return")
    ) {
      return;
    }
    setError(null);
    void (async () => {
        const response = await fetch(
          `/reps/${representativeSlug}/recharge/${order.id}/mock-reversal`,
          { method: "POST" },
        );
        if (!response.ok) {
          throw new Error(await extractError(response));
        }
        const payload = (await response.json()) as {
          reversal: PurchaseReversalSnapshot;
          walletBalance: UserAgentWalletBalance | null;
        };
        const availableTokenAmount =
          payload.walletBalance?.availableTokenAmount ?? 0;
        const reservedTokenAmount =
          payload.walletBalance?.reservedTokenAmount ?? 0;
        setReversal(payload.reversal);
        setOrder((current) => current
          ? { ...current, cashBalanceCents: payload.reversal.cashBalanceCents }
          : current);
        setPurchase((current) => current
          ? {
              ...current,
              remainingTokenAmount: payload.reversal.remainingTokenAmount,
              availableTokenAmount,
              reservedTokenAmount,
            }
          : current);
        publishPublicWalletUpdate({
          representativeSlug,
          serviceCreditsAvailable: availableTokenAmount,
          serviceCreditsReserved: reservedTokenAmount,
        });
        await restoreAfterMutation();
      })()
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.returnError);
      })
      .finally(endMutation);
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

  return (
    <div className="setup-stack">
      <p className="footer-note">{t.identityNote}</p>

      {paymentMode === "wechat" && !collectionEnabled ? (
        <div className="status-banner status-warning" role="status">
          <strong>{t.wechatCollectionPausedTitle}</strong>
          <p>{t.wechatCollectionPausedDetail}</p>
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

      {continuationChannel === "telegram" && audienceAuthenticated ? (
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
              <a className="button-secondary" href="#identity-bindings">
                {t.openBindingsAction}
              </a>
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
            {t.balanceLabel}
            {formatMoney(
              walletState.summary.cashBalanceCents,
              walletState.summary.currency,
            )}
            {" · "}
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

      <div className="button-row button-row-stretch">
        {[500, 2000, 10000].map((preset) => (
          <button
            className={amountCents === preset ? "button-primary" : "button-secondary"}
            disabled={
              !collectionEnabled
              || isMutating
              || isRestoring
              || !rechargeReady
              || hasActivePendingCheckout
              || paymentResultConfirmed
              || checkoutRequiresManualAction
            }
            key={preset}
            onClick={() => {
              setAmountCents(preset);
              if (
                rechargeIntentRef.current
                && rechargeIntentRef.current.amountCents !== preset
              ) {
                rechargeIntentRef.current = null;
              }
            }}
            type="button"
          >
            {formatMoney(preset, "CNY")}
          </button>
        ))}
      </div>

      <button
        className="button-primary button-block"
        disabled={
          !collectionEnabled
          || isMutating
          || isRestoring
          || !rechargeReady
          || hasActiveWeChatOrder
          || paymentResultConfirmed
          || checkoutRequiresManualAction
        }
        onClick={createRechargeOrder}
        type="button"
      >
        {mutation === "create"
          ? t.creating
          : paymentMode === "wechat" && !collectionEnabled
            ? t.wechatCollectionPausedAction
            : checkoutExpired
              ? checkoutRequiresManualAction
                ? t.wechatExpiryConfirmationAction
                : t.regenerateWechatAction
              : hasRecoveringWeChatOrder
                ? t.wechatRecoveringAction
              : hasActivePendingCheckout
                ? t.wechatPendingAction
                : paymentMode === "wechat"
                  ? t.wechatCreateAction
                  : t.createAction}
      </button>
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
            {formatMoney(order.amountCents, order.currency)}
            {" · "}
            <span className="representative-payment-status">
              {paymentResultConfirmed
                ? t.paymentConfirmedStatus
                : orderPresentation?.label}
            </span>
            {" · "}
            {t.balanceLabel}
            {formatMoney(order.cashBalanceCents, order.currency)}
          </p>
          {order.status === "requires_payment" && paymentMode === "mock" ? (
            <button
              className="button-secondary"
              disabled={isMutating || isRestoring}
              onClick={completeMockPayment}
              type="button"
            >
              {t.mockPayAction}
            </button>
          ) : null}
          {order.status === "requires_payment"
            && paymentMode === "wechat"
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
                  <p>{t.wechatQrDetail}</p>
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
          {purchase ? (
            <>
              <p>
                {t.creditsLabel}
                <strong>{purchase.availableTokenAmount}</strong>
                {" · "}
                {t.creditsScope}
              </p>
              {purchase.remainingTokenAmount > 0
                && paymentMode === "mock" ? (
                  <button
                    className="button-secondary"
                    disabled={
                      isMutating
                      || isRestoring
                      || purchase.reservedTokenAmount > 0
                    }
                    onClick={returnUnusedCredits}
                    type="button"
                  >
                    {mutation === "return"
                      ? t.returning
                      : t.returnUnusedAction}
                  </button>
                ) : null}
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
                reversal.cashBalanceCents,
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

      {error ? <div className="status-banner status-error">{error}</div> : null}
      <p className="footer-note">
        {paymentMode === "wechat"
          ? t.wechatDisclaimer
          : t.disclaimer}
      </p>
    </div>
  );
}

async function extractError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? response.statusText;
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
    identityNote: "充值和服务额度会记入当前已登录的 Delegate 账户；绑定后 Web、Telegram 和 Matrix 共用同一份权益。这里只读取当前代表的 CNY 钱包状态。",
    restoring: "正在恢复当前钱包状态…",
    loadError: "钱包状态恢复失败。",
    refreshError: "操作已完成，但最新钱包状态暂时无法刷新，请重新加载页面。",
    walletSummaryTitle: "当前钱包状态",
    creditsAvailableLabel: "可用额度 ",
    creditsReservedLabel: "预留额度 ",
    creditsConsumedLabel: "已消费额度 ",
    recordSummary: (orders: number, purchases: number, refunds: number) =>
      `最近记录：${orders} 笔订单 · ${purchases} 笔购买 · ${refunds} 笔未使用额度退回`,
    loginRequiredTitle: "请先登录 Delegate 账户",
    loginRequiredDetail: "充值属于账户级操作，不会再记入临时浏览器身份。",
    loginAction: "登录 / 注册",
    telegramBindingRequiredTitle: "请先绑定当前 Telegram 账户",
    telegramBindingRequiredDetail: "在上方“跨渠道身份”生成 /bind 命令，发送给当前 Bot 后再回来检查。",
    telegramBindingReadyTitle: "Telegram 身份已绑定",
    telegramBindingReadyDetail: "本次充值会进入与当前 Telegram 账户对应的同一个 Delegate 账户。",
    openBindingsAction: "打开身份绑定",
    checkBindingAction: "重新检查",
    checkingBinding: "检查中...",
    bindingCheckError: "Telegram 绑定状态检查失败。",
    createAction: "创建充值单",
    wechatCreateAction: "生成微信支付二维码",
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
    createError: "创建充值单失败。",
    payError: "模拟支付失败。",
    latestOrder: "最近一笔充值单",
    balanceLabel: "当前余额 ",
    mockPayAction: "模拟支付成功",
    wechatQrTitle: "微信扫码支付",
    wechatQrDetail: "请使用微信扫描二维码。支付完成后，本页会自动刷新余额和当前代表服务额度。",
    wechatCountdown: (time: string) => `二维码剩余有效时间 ${time}`,
    wechatAwaitingPayment: "正在等待微信支付确认。",
    wechatRecovering: "微信支付订单正在安全确认，二维码生成后会自动显示。",
    wechatExpiredDetail: "当前二维码已过期，不会再展示。请重新生成后再扫码支付。",
    wechatExpiredConfirming: "二维码已到期，正在做最后一次支付结果确认。确认完成前请勿重复支付。",
    wechatExpiredConfirmed: "二维码已到期，暂未发现成功支付；系统正在等待微信安全关闭旧订单，关闭前请勿创建新订单。",
    wechatExpiredUnconfirmed: "二维码已到期，但支付结果暂时无法确认。请勿重复支付；系统会继续查询。",
    retryPaymentStatusAction: "重新查询支付结果",
    wechatAuthExpired: "登录状态已失效，支付查询已停止。请重新登录后核对订单。",
    wechatManualReview: "支付结果与钱包账目需要人工核对，自动查询已停止。",
    wechatManualReviewAction: "请勿重复支付。联系数字代表主人并提供当前订单时间和金额进行核对。",
    wechatProviderRetry: "微信支付状态暂时不可用，本页会降低频率后自动重试。",
    wechatStatusRetry: "网络暂时不可用，本页会自动重试支付状态。",
    wechatOffline: "当前设备已离线；支付查询已暂停，恢复联网后会自动继续。",
    wechatPaidRefreshing: "微信支付已确认，正在刷新钱包和服务额度…",
    wechatPaid: "微信支付已确认，钱包和服务额度已更新。",
    wechatPaidRefreshFailed: "微信支付已确认，但钱包状态暂时无法刷新。请勿重复支付，可重新读取钱包。",
    wechatExistingCheckoutRestored: "已恢复仍在有效期内的待支付二维码。",
    paymentConfirmedStatus: "支付已确认",
    refreshWalletAction: "重新读取钱包",
    openWechatAction: "在微信中打开",
    copyCheckoutUrl: "复制支付链接",
    checkoutUrlCopied: "已复制",
    copyError: "支付链接复制失败，请直接扫描二维码。",
    creditsLabel: "当前代表可用服务额度 ",
    creditsScope: "仅限当前数字代表",
    returnUnusedAction: "退回本次未使用额度",
    returning: "退回中...",
    returnError: "未使用额度退回失败。",
    reservedReturnHint: "有额度正在服务请求中，结算或释放后才能退回。",
    returnedTitle: "未使用额度已退回站内余额",
    returnedDetail: (
      tokens: number,
      amountCents: number,
      currency: string,
      cashBalanceCents: number,
    ) => `${tokens} 额度 · ${formatMoney(amountCents, currency)} · 站内余额 ${formatMoney(cashBalanceCents, currency)}`,
    disclaimer: "当前是仅限开发环境的演示支付入口：可以验证创建充值单、模拟支付、自动购买当前代表服务额度、付费继续和未使用额度退回站内余额，但不会真实扣款或原路退款。下一真实收款渠道为微信支付；Stripe 已延期。Delegate 不处理银行卡号或支付密码。",
    wechatDisclaimer: "当前使用微信 Native 支付。Delegate 只保存订单、金额和验签后的最小资金凭据，不接触微信支付密码；支付成功后会为当前数字代表自动购买服务额度。真实退款和自动提现仍未开放。",
  },
  en: {
    identityNote: "Recharge and service credits are attached to the signed-in Delegate account. Linked Web, Telegram, and Matrix identities share the same entitlements. This panel reads only this representative's CNY wallet state.",
    restoring: "Restoring the current wallet state…",
    loadError: "Failed to restore wallet state.",
    refreshError: "The operation completed, but the latest wallet state could not be refreshed. Reload the page to try again.",
    walletSummaryTitle: "Current wallet state",
    creditsAvailableLabel: "available credits ",
    creditsReservedLabel: "reserved credits ",
    creditsConsumedLabel: "consumed credits ",
    recordSummary: (orders: number, purchases: number, refunds: number) =>
      `Recent records: ${orders} orders · ${purchases} purchases · ${refunds} unused-credit returns`,
    loginRequiredTitle: "Sign in to your Delegate account",
    loginRequiredDetail: "Recharge is account-bound and is never attached to a temporary browser identity.",
    loginAction: "Sign in / register",
    telegramBindingRequiredTitle: "Link this Telegram account first",
    telegramBindingRequiredDetail: "Create a /bind command in Cross-channel identity above, send it to this Bot, then check again.",
    telegramBindingReadyTitle: "Telegram identity linked",
    telegramBindingReadyDetail: "This recharge will reach the same Delegate account used by the current Telegram identity.",
    openBindingsAction: "Open identity linking",
    checkBindingAction: "Check again",
    checkingBinding: "Checking...",
    bindingCheckError: "Unable to check the Telegram identity link.",
    createAction: "Create recharge order",
    wechatCreateAction: "Generate WeChat Pay QR",
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
    createError: "Failed to create recharge order.",
    payError: "Failed to simulate payment.",
    latestOrder: "Latest recharge order",
    balanceLabel: "Current balance ",
    mockPayAction: "Simulate payment success",
    wechatQrTitle: "Scan with WeChat Pay",
    wechatQrDetail: "Scan this QR code in WeChat. This page will refresh the wallet and representative-scoped service credits after payment.",
    wechatCountdown: (time: string) => `QR code expires in ${time}`,
    wechatAwaitingPayment: "Waiting for WeChat Pay confirmation.",
    wechatRecovering: "The WeChat Pay order is being verified. Its QR code will appear automatically when ready.",
    wechatExpiredDetail: "This QR code has expired and is no longer shown. Generate a new one before paying.",
    wechatExpiredConfirming: "The QR code expired. A final payment-result check is in progress; do not pay again yet.",
    wechatExpiredConfirmed: "The QR code expired and no successful payment is confirmed yet. The old order is being closed safely; do not create a new one yet.",
    wechatExpiredUnconfirmed: "The QR code expired, but its payment result is temporarily unavailable. Do not pay again; checks will continue.",
    retryPaymentStatusAction: "Retry payment status",
    wechatAuthExpired: "Your session expired, so payment checks stopped. Sign in again to verify this order.",
    wechatManualReview: "The payment result and wallet records need manual review. Automatic checks have stopped.",
    wechatManualReviewAction: "Do not pay again. Contact the representative owner with the order time and amount for verification.",
    wechatProviderRetry: "WeChat Pay status is temporarily unavailable. This page will retry at a lower frequency.",
    wechatStatusRetry: "The network is temporarily unavailable. This page will retry the payment status.",
    wechatOffline: "This device is offline. Payment checks are paused and will resume when the connection returns.",
    wechatPaidRefreshing: "WeChat Pay is confirmed. Refreshing wallet cash and service credits…",
    wechatPaid: "WeChat Pay is confirmed. Wallet cash and service credits are up to date.",
    wechatPaidRefreshFailed: "WeChat Pay is confirmed, but the wallet could not refresh yet. Do not pay again; retry the wallet read.",
    wechatExistingCheckoutRestored: "The still-valid pending checkout has been restored.",
    paymentConfirmedStatus: "Payment confirmed",
    refreshWalletAction: "Refresh wallet",
    openWechatAction: "Open in WeChat",
    copyCheckoutUrl: "Copy payment link",
    checkoutUrlCopied: "Copied",
    copyError: "The payment link could not be copied. Please scan the QR code.",
    creditsLabel: "Service credits available for this representative ",
    creditsScope: "scoped to this Digital Representative",
    returnUnusedAction: "Return unused credits",
    returning: "Returning...",
    returnError: "Failed to return unused credits.",
    reservedReturnHint: "Credits reserved by an active service request can be returned after settlement or release.",
    returnedTitle: "Unused credits returned to wallet cash",
    returnedDetail: (
      tokens: number,
      amountCents: number,
      currency: string,
      cashBalanceCents: number,
    ) => `${tokens} credits · ${formatMoney(amountCents, currency)} · wallet cash ${formatMoney(cashBalanceCents, currency)}`,
    disclaimer: "This development-only demo validates order creation, simulated payment, representative-scoped credit purchase, paid continuation, and returning unused credits to wallet cash without a real charge or provider refund. WeChat Pay is the next live collection channel; Stripe is deferred. Delegate does not handle card numbers or payment passwords.",
    wechatDisclaimer: "This checkout uses WeChat Pay Native. Delegate stores only the order, amount, and minimal verified payment evidence; it never handles a WeChat payment password. Successful payment automatically purchases service credits for this Digital Representative. Live refunds and automated payouts remain unavailable.",
  },
} as const;
