"use client";

import { useEffect, useRef, useState } from "react";

import type { Locale } from "@delegate/web-ui";

import {
  bindingPollRetryDelayMs,
  isInstructionBindingCurrent,
} from "./identity-binding-polling";

type BindingSnapshot = {
  provider: "TELEGRAM" | "MATRIX";
  providerSubject: string;
  issuer: string;
  connectionId: string | null;
  verifiedAt: string | null;
};

type TelegramBotEndpoint = {
  botId: string;
  username: string | null;
};

type MatrixEndpoint = {
  matrixUserId: string;
  connectionId: string;
};

type BindingInstruction = {
  challengeId: string;
  replacing: boolean;
  provider: "telegram" | "matrix";
  command: string;
  expiresAt: string;
  scope: {
    issuer: string;
    connectionId: string;
  };
  expectedProviderSubject?: string;
  telegramBot?: TelegramBotEndpoint;
  matrixEndpoint?: MatrixEndpoint;
};

type BindingInstructionResponse = Omit<BindingInstruction, "replacing">;

type BindingCapabilities = {
  telegram: boolean;
  matrix: boolean;
};

type BindingStatePayload = {
  bindings: BindingSnapshot[];
  currentBindings: {
    telegram: BindingSnapshot[];
    matrix: BindingSnapshot[];
  };
  readiness: BindingCapabilities;
  capabilities: BindingCapabilities;
  telegramBot: TelegramBotEndpoint | null;
  matrixEndpoint: MatrixEndpoint | null;
};

type BindingChallengeState = {
  challengeId: string;
  status: "PENDING" | "CONSUMED" | "EXPIRED" | "REVOKED";
  expiresAt: string;
  providerSubject?: string;
};

export function RepresentativeIdentityBindingPanel({
  locale,
  representativeSlug,
}: {
  locale: Locale;
  representativeSlug: string;
}) {
  const zh = locale === "zh";
  const [bindings, setBindings] = useState<BindingSnapshot[]>([]);
  const [currentBindings, setCurrentBindings] = useState<{
    telegram: BindingSnapshot[];
    matrix: BindingSnapshot[];
  }>({ telegram: [], matrix: [] });
  const [readiness, setReadiness] =
    useState<BindingCapabilities>({ telegram: false, matrix: false });
  const [telegramBot, setTelegramBot] =
    useState<TelegramBotEndpoint | null>(null);
  const [matrixEndpoint, setMatrixEndpoint] =
    useState<MatrixEndpoint | null>(null);
  const [capabilities, setCapabilities] =
    useState<BindingCapabilities | null>(null);
  const [matrixUserId, setMatrixUserId] = useState("");
  const [instruction, setInstruction] = useState<BindingInstruction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingProvider, setCreatingProvider] =
    useState<"telegram" | "matrix" | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copiedMatrixTarget, setCopiedMatrixTarget] = useState<string | null>(
    null,
  );
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const [bindingLoadStatus, setBindingLoadStatus] =
    useState<"loading" | "loaded" | "error">("loading");
  const [bindingLoadError, setBindingLoadError] = useState<string | null>(null);
  const [bindingLoadAttempt, setBindingLoadAttempt] = useState(0);
  const [bindingPollAttempt, setBindingPollAttempt] = useState(0);
  const [bindingPollPaused, setBindingPollPaused] = useState(false);
  const operationGenerationRef = useRef(0);

  useEffect(() => {
    operationGenerationRef.current += 1;
    setInstruction(null);
    setNotice(null);
    setError(null);
    setCopiedCommand(null);
    setRevokingKey(null);
    setCreatingProvider(null);
    setBindingPollAttempt(0);
    setBindingPollPaused(false);
  }, [representativeSlug]);

  useEffect(() => {
    let active = true;
    setBindingLoadStatus("loading");
    setBindingLoadError(null);
    setCapabilities(null);
    setCurrentBindings({ telegram: [], matrix: [] });
    setReadiness({ telegram: false, matrix: false });
    setTelegramBot(null);
    setMatrixEndpoint(null);
    void fetchBindingState(representativeSlug)
      .then((payload) => {
        if (active) {
          setBindings(payload.bindings);
          setCurrentBindings(payload.currentBindings);
          setReadiness(payload.readiness);
          setCapabilities(payload.capabilities);
          setTelegramBot(payload.telegramBot);
          setMatrixEndpoint(payload.matrixEndpoint);
          setMatrixUserId(
            payload.currentBindings.matrix.length === 1
              ? payload.currentBindings.matrix[0]!.providerSubject
              : "",
          );
          setBindingLoadStatus("loaded");
        }
      })
      .catch((nextError: unknown) => {
        if (active) {
          setBindingLoadStatus("error");
          setBindingLoadError(
            nextError instanceof Error
              ? nextError.message
              : zh
                ? "读取绑定状态失败。"
                : "Unable to load bindings.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [bindingLoadAttempt, representativeSlug, zh]);

  useEffect(() => {
    if (!instruction) return;
    setBindingPollPaused(false);
    let active = true;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    const scheduleNextPoll = (delayMs = 2_000) => {
      if (!active) return;
      timer = window.setTimeout(() => {
        void poll();
      }, delayMs);
    };
    const poll = async () => {
      if (!active) return;
      let shouldContinue = true;
      let nextPollDelayMs = 2_000;
      let confirmedConsumed = false;
      try {
        const challenge = await fetchBindingChallengeState(
          representativeSlug,
          instruction.challengeId,
        );
        if (!active) return;
        if (challenge.status === "PENDING") {
          consecutiveFailures = 0;
          setError(null);
          return;
        }
        if (challenge.status !== "CONSUMED") {
          shouldContinue = false;
          setBindingPollPaused(false);
          setInstruction(null);
          setCopiedCommand(null);
          setError(
            challenge.status === "EXPIRED"
              ? zh
                ? "一次性绑定命令已过期，请重新生成。"
                : "The one-time binding command expired. Create a new one."
              : zh
                ? "这条一次性绑定命令已失效，请重新生成。"
                : "This one-time binding command is no longer valid. Create a new one.",
          );
          return;
        }
        confirmedConsumed = true;
        const payload = await fetchBindingState(representativeSlug);
        if (!active) return;
        setBindings(payload.bindings);
        setCurrentBindings(payload.currentBindings);
        setReadiness(payload.readiness);
        setCapabilities(payload.capabilities);
        setTelegramBot(payload.telegramBot);
        setMatrixEndpoint(payload.matrixEndpoint);
        setMatrixUserId(
          payload.currentBindings.matrix.length === 1
            ? payload.currentBindings.matrix[0]!.providerSubject
            : "",
        );
        shouldContinue = false;
        setBindingPollPaused(false);
        setInstruction(null);
        setCopiedCommand(null);
        setError(null);
        if (
          !isInstructionBindingCurrent(
            payload.currentBindings,
            {
              ...instruction,
              ...(challenge.providerSubject
                ? {
                    consumedProviderSubject:
                      challenge.providerSubject,
                  }
                : {}),
            },
          )
        ) {
          setNotice(null);
          setError(
            zh
              ? "一次性命令已经消费，但该账号已不在当前代表的渠道连接上，可能已在其他页面解除绑定或渠道已被替换。页面已显示实际状态，请重新生成命令。"
              : "The one-time command was consumed, but that account is no longer on this representative's current channel connection. It may have been unlinked elsewhere or the endpoint may have changed. The page now shows the actual state; create a new command.",
          );
          return;
        }
        setNotice(
          instruction.provider === "matrix"
            ? instruction.replacing
              ? zh
                ? "Matrix 账号已验证并替换完成。当前未加密私聊可以继续使用；旧 MXID 仅在当前 Matrix 连接下失效，其他连接和历史记录不受影响。"
                : "The Matrix account was verified and replaced. The current unencrypted room can continue; the old MXID is revoked only for this Matrix connection, while other connections and history remain unchanged."
              : zh
                ? "Matrix 账号绑定成功。当前未加密私聊已与登录的 Delegate 账号对应，代表专属服务额度会在 Web 与 Matrix 间保持一致。"
                : "Matrix linked. This unencrypted room now maps to the signed-in Delegate account and shares its representative-scoped service credits with Web."
            : zh
              ? "Telegram 绑定成功。这个私聊账号现在会使用当前 Delegate 账号在该代表下的服务额度。"
              : "Telegram linked. This private-chat account now uses the signed-in Delegate account's service credits for this representative.",
        );
      } catch (nextError) {
        if (!active) return;
        if (
          nextError instanceof BindingRequestError
          && [400, 401, 403, 404].includes(nextError.status)
        ) {
          shouldContinue = false;
          setBindingPollPaused(false);
          setInstruction(null);
          setCopiedCommand(null);
          setError(nextError.message);
          return;
        }
        consecutiveFailures += 1;
        const retryDelay =
          bindingPollRetryDelayMs(consecutiveFailures);
        if (retryDelay === null) {
          shouldContinue = false;
          setBindingPollPaused(true);
        } else {
          nextPollDelayMs = retryDelay;
        }
        setError(
          retryDelay === null
            ? zh
              ? "连续多次无法读取绑定状态，自动检查已暂停。请检查网络后点击“重新检查绑定状态”。"
              : "Binding status could not be loaded repeatedly, so automatic checks are paused. Check your connection, then choose “Check binding status again”."
            : confirmedConsumed
            ? zh
              ? "账号验证已经完成，但页面暂时无法同步最新绑定状态；系统将稍后重试，你也可以刷新页面确认。"
              : "Account verification completed, but the latest binding state could not be synchronized. Retrying with backoff; you can also refresh the page to confirm."
            : zh
              ? "暂时无法查询一次性命令状态，系统将稍后重试。"
              : "The one-time command status is temporarily unavailable. Retrying with backoff.",
        );
      } finally {
        if (shouldContinue) {
          scheduleNextPoll(nextPollDelayMs);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [bindingPollAttempt, instruction, representativeSlug, zh]);

  function createBinding(provider: "telegram" | "matrix") {
    if (creatingProvider) return;
    const operationGeneration = operationGenerationRef.current;
    const requestedMatrixUserId = matrixUserId.trim();
    setError(null);
    setNotice(null);
    setInstruction(null);
    setBindingPollPaused(false);
    setCopiedCommand(null);
    setCreatingProvider(provider);
    void fetch(`/reps/${representativeSlug}/identity-bindings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        ...(provider === "matrix" ? { providerSubject: matrixUserId } : {}),
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await extractError(response));
        return response.json() as Promise<BindingInstructionResponse>;
      })
      .then((nextInstruction) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setInstruction({
          ...nextInstruction,
          replacing:
            provider === "matrix"
            && currentBindings.matrix.some(
              (binding) =>
                binding.providerSubject !== requestedMatrixUserId,
            ),
        });
        if (nextInstruction.telegramBot) {
          setTelegramBot(nextInstruction.telegramBot);
        }
        if (nextInstruction.matrixEndpoint) {
          setMatrixEndpoint(nextInstruction.matrixEndpoint);
        }
      })
      .catch((nextError: unknown) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "生成绑定命令失败。"
              : "Unable to create a binding command.",
        );
      })
      .finally(() => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setCreatingProvider((current) =>
          current === provider ? null : current,
        );
      });
  }

  async function copyBindingCommand() {
    if (!instruction) return;
    try {
      await navigator.clipboard.writeText(instruction.command);
      setCopiedCommand(instruction.command);
      setError(null);
    } catch {
      setError(
        zh
          ? "复制失败，请手动选择并复制命令。"
          : "Copy failed. Select and copy the command manually.",
      );
    }
  }

  async function copyMatrixTarget() {
    if (!matrixEndpoint) return;
    try {
      await navigator.clipboard.writeText(matrixEndpoint.matrixUserId);
      setCopiedMatrixTarget(matrixEndpoint.matrixUserId);
      setError(null);
    } catch {
      setError(
        zh
          ? "复制失败，请手动选择并复制目标 MXID。"
          : "Copy failed. Select and copy the destination MXID manually.",
      );
    }
  }

  function revokeBinding(binding: BindingSnapshot) {
    if (!binding.connectionId) {
      setError(
        zh
          ? "该旧版绑定缺少连接范围，无法安全解除；请先重新绑定到当前渠道。"
          : "This legacy binding has no connection scope and cannot be safely unlinked. Bind it to the current channel first.",
      );
      return;
    }
    const key = bindingKey(binding);
    const target =
      binding.provider === "TELEGRAM"
        ? telegramBindingTarget(binding, telegramBot)
        : binding.connectionId;
    const confirmed = window.confirm(
      binding.provider === "TELEGRAM"
        ? zh
          ? `解除后，此 Telegram 账号在 ${target} 下将不再对应当前 Delegate 账号。如果同一个 Bot 被多个数字代表共用，这些代表都会受影响。历史消息、服务额度和订单不会删除。继续吗？`
          : `This Telegram account will no longer map to the current Delegate account on ${target}. If several representatives share that Bot, all of them are affected. History, service credits, and orders are preserved. Continue?`
        : zh
          ? `解除后，此 Matrix 账号在连接 ${target} 下将不再对应当前 Delegate 账号；共用该连接的代表都会受影响。历史消息、服务额度和订单不会删除。继续吗？`
          : `This Matrix account will no longer map to the current Delegate account on connection ${target}; representatives sharing it are affected. History, service credits, and orders are preserved. Continue?`,
    );
    if (!confirmed) return;

    const operationGeneration = operationGenerationRef.current;
    setError(null);
    setNotice(null);
    setRevokingKey(key);
    void fetch(`/reps/${representativeSlug}/identity-bindings`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: binding.provider.toLowerCase(),
        providerSubject: binding.providerSubject,
        issuer: binding.issuer,
        connectionId: binding.connectionId,
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await extractError(response));
        return response.json() as Promise<{ changed: boolean }>;
      })
      .then(async (result) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        let payload: BindingStatePayload;
        try {
          payload = await fetchBindingState(representativeSlug);
        } catch (refreshError) {
          const reason =
            refreshError instanceof Error ? refreshError.message : "";
            if (result.changed) {
              setNotice(
                zh
                ? "解除绑定已经完成，但页面暂时无法同步最新状态，正在重新读取；历史消息、服务额度和订单均已保留。"
                : "The binding was unlinked, but the page could not synchronize the latest state and is reloading it. History, service credits, and orders are preserved.",
            );
            setBindingLoadAttempt((current) => current + 1);
            return;
          }
          throw new Error(
            zh
              ? `解除结果未发生变更，但无法读取最新绑定状态，请重试刷新。${reason ? ` ${reason}` : ""}`
              : `The unlink result did not change, but the latest binding state could not be loaded. Retry the refresh.${reason ? ` ${reason}` : ""}`,
          );
        }
        if (operationGenerationRef.current !== operationGeneration) return;
        setBindings(payload.bindings);
        setCurrentBindings(payload.currentBindings);
        setReadiness(payload.readiness);
        setCapabilities(payload.capabilities);
        setTelegramBot(payload.telegramBot);
        setMatrixEndpoint(payload.matrixEndpoint);
        setMatrixUserId(
          payload.currentBindings.matrix.length === 1
            ? payload.currentBindings.matrix[0]!.providerSubject
            : "",
        );
        const stillLinked = payload.bindings.some(
          (candidate) => bindingKey(candidate) === key,
        );
        setNotice(
          result.changed && stillLinked
            ? zh
              ? "解除已完成，但另一项并发操作又验证了同一连接；页面已按服务端实际状态同步。"
              : "The unlink completed, but another concurrent operation verified the same connection again. The page now reflects the authoritative server state."
            : result.changed
              ? zh
                ? "已解除该渠道连接。历史消息、服务额度和订单均已保留；如需恢复，请重新生成并发送一次性绑定命令。"
                : "The channel connection is unlinked. History, service credits, and orders are preserved; create and send a new one-time command to restore it."
              : stillLinked
                ? zh
                  ? "绑定状态已在其他操作中发生变化，当前连接仍然有效；页面已同步最新状态。"
                  : "The binding changed in another operation and is still active. The page now shows the latest state."
                : zh
                  ? "该连接此前已解除，页面已同步最新状态。历史消息、服务额度和订单均已保留。"
                  : "This connection was already unlinked. The page now shows the latest state, and history, service credits, and orders are preserved.",
        );
      })
      .catch((nextError: unknown) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "解除绑定失败。"
              : "Unable to unlink this connection.",
        );
      })
      .finally(() => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setRevokingKey((current) => (current === key ? null : current));
      });
  }

  return (
    <div className="setup-stack">
      {bindingLoadStatus === "loading" ? (
        <p className="footer-note" role="status">
          {zh ? "正在读取私聊账户绑定状态…" : "Loading linked private-channel accounts…"}
        </p>
      ) : bindingLoadStatus === "error" ? (
        <div className="status-banner status-error" role="alert">
          <span>
            {bindingLoadError
              ?? (zh
                ? "读取绑定状态失败。"
                : "Unable to load bindings.")}
          </span>
          <div className="chip-row">
            <button
              className="button-secondary"
              onClick={() => setBindingLoadAttempt((current) => current + 1)}
              type="button"
            >
              {zh ? "重试" : "Retry"}
            </button>
          </div>
        </div>
      ) : bindings.length ? (
        <div className="chip-row" aria-label={zh ? "已绑定账户" : "Linked accounts"}>
          {bindings.map((binding) => {
            const key = bindingKey(binding);
            return (
              <span className="identity-binding-item" key={key}>
                <span className="chip chip-safe">
                  {binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} ·{" "}
                  {binding.providerSubject}
                  {binding.provider === "TELEGRAM" ? (
                    <>
                      {" · "}
                      {telegramBindingTarget(binding, telegramBot)}
                      {telegramBot?.botId === binding.connectionId
                        ? zh
                          ? " · 当前代表"
                          : " · Current representative"
                        : null}
                    </>
                  ) : (
                    <>
                      {" · "}
                      {binding.connectionId
                        ?? (zh ? "旧版绑定，需重新绑定" : "Legacy binding; rebind required")}
                    </>
                  )}
                </span>
                <button
                  aria-label={
                    zh
                      ? `解除 ${binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} 连接`
                      : `Unlink ${binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} connection`
                  }
                  className="identity-binding-unlink"
                  disabled={
                    binding.connectionId === null
                    || revokingKey !== null
                    || creatingProvider !== null
                  }
                  onClick={() => revokeBinding(binding)}
                  type="button"
                >
                  {binding.connectionId === null
                    ? zh
                      ? "需重新绑定"
                      : "Rebind required"
                    : revokingKey === key
                    ? zh
                      ? "解除中…"
                      : "Unlinking…"
                    : zh
                      ? "解除绑定"
                      : "Unlink"}
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="footer-note">
          {zh
            ? "目前没有绑定的私聊账户。"
            : "No private-channel account is linked yet."}
        </p>
      )}

      <div className="setup-grid">
        {capabilities?.telegram ? (
          <article className="representative-capability-card">
          <strong>Telegram</strong>
          <p>
            {zh
              ? "把当前登录的 Delegate 账号与 Telegram 私聊身份关联，Web 与 Telegram 中的代表专属服务额度会保持一致。系统会明确显示当前代表使用的目标 Bot，请只在该 Bot 私聊中发送一次性命令。"
              : "Link the signed-in Delegate account to your Telegram private-chat identity so representative-scoped service credits stay aligned across Web and Telegram. The exact Bot for this representative will be shown with the one-time command."}
          </p>
          <div className="field-stack">
            <span className="field-hint">
              {zh ? "当前代表下已绑定的 Telegram 账号" : "Telegram account linked for this representative"}
            </span>
            <strong>
              {currentBindings.telegram.length
                ? currentBindings.telegram
                    .map((binding) => binding.providerSubject)
                    .join(zh ? "、" : ", ")
                : zh
                  ? "尚未绑定"
                  : "Not linked"}
            </strong>
            {readiness.telegram ? (
              <span className="footer-note">
                {zh ? "已验证，可共享该代表的 Web 服务额度。" : "Verified and sharing this representative's Web service credits."}
              </span>
            ) : null}
          </div>
          <button
            className="button-secondary"
            disabled={creatingProvider !== null || revokingKey !== null}
            onClick={() => createBinding("telegram")}
            type="button"
          >
            {creatingProvider === "telegram"
              ? zh
                ? "生成中…"
                : "Creating…"
              : zh
                ? currentBindings.telegram.length
                  ? "绑定另一个或重新验证 Telegram 账号"
                  : "绑定我的 Telegram 账号"
                : currentBindings.telegram.length
                  ? "Link another or reverify a Telegram account"
                  : "Link my Telegram account"}
          </button>
          </article>
        ) : null}

        {capabilities?.matrix ? (
          <article className="representative-capability-card">
          <strong>Matrix</strong>
          <p>
            {zh
              ? "先复制代表的目标 MXID 并创建未加密的一对一私聊，再填写你自己的完整 MXID。一次性命令只能由这个账号在该私聊中发送。"
              : "Copy the representative's destination MXID and create an unencrypted one-to-one room first. Then enter your own full MXID; only that account can use the one-time command in this room."}
          </p>
          {matrixEndpoint ? (
            <div className="field-stack">
              <span className="field-hint">
                {zh ? "代表的目标 Matrix MXID" : "Representative destination MXID"}
              </span>
              <pre className="artifact-preview">{matrixEndpoint.matrixUserId}</pre>
              <div className="chip-row">
                <button
                  className="button-secondary"
                  disabled={
                    copiedMatrixTarget === matrixEndpoint.matrixUserId
                  }
                  onClick={() => void copyMatrixTarget()}
                  type="button"
                >
                  {copiedMatrixTarget === matrixEndpoint.matrixUserId
                    ? zh
                      ? "目标 MXID 已复制"
                      : "Destination MXID copied"
                    : zh
                      ? "复制目标 MXID"
                      : "Copy destination MXID"}
                </button>
              </div>
              <span className="footer-note">
                {zh ? "连接范围：" : "Connection scope: "}
                {matrixEndpoint.connectionId}
              </span>
            </div>
          ) : null}
          {currentBindings.matrix.length ? (
            <div className="field-stack">
              <span className="field-hint">
                {zh
                  ? "当前代表连接下已绑定的 Matrix 账号"
                  : "Matrix accounts linked on this representative connection"}
              </span>
              <strong>
                {currentBindings.matrix
                  .map((binding) => binding.providerSubject)
                  .join(zh ? "、" : ", ")}
              </strong>
            </div>
          ) : null}
          <label className="field-stack">
            <span className="field-hint">
              {zh
                ? currentBindings.matrix.length
                  ? "当前绑定的 Matrix MXID（可输入新账号替换）"
                  : "你自己的 Matrix MXID"
                : currentBindings.matrix.length
                  ? "Current Matrix MXID (enter a new account to replace it)"
                  : "Your Matrix MXID"}
            </span>
            <input
              autoComplete="username"
              className="text-input"
              onChange={(event) => setMatrixUserId(event.target.value)}
              placeholder="@alice:example.org"
              spellCheck={false}
              value={matrixUserId}
            />
            {currentBindings.matrix.length > 1 ? (
              <span className="footer-note">
                {zh
                  ? `检测到 ${currentBindings.matrix.length} 个旧版有效账号；新 MXID 验证成功后，它们只会在当前 Matrix 连接下失效。`
                  : `${currentBindings.matrix.length} legacy active accounts were found. After the new MXID is verified, they are revoked only for this Matrix connection.`}
              </span>
            ) : readiness.matrix ? (
              <span className="footer-note">
                {zh ? "已验证，可共享该代表的 Web 服务额度。" : "Verified and sharing this representative's Web service credits."}
              </span>
            ) : null}
          </label>
          <button
            className="button-secondary"
            disabled={
              creatingProvider !== null
              || revokingKey !== null
              || !matrixUserId.trim()
            }
            onClick={() => createBinding("matrix")}
            type="button"
          >
            {creatingProvider === "matrix"
              ? zh
                ? "生成中…"
                : "Creating…"
              : zh
                ? currentBindings.matrix.length
                  ? "生成 Matrix 替换命令"
                  : "为这个 Matrix 账号生成绑定命令"
                : currentBindings.matrix.length
                  ? "Create Matrix replacement command"
                  : "Create command for this Matrix account"}
          </button>
          </article>
        ) : null}
      </div>

      {capabilities
      && !capabilities.telegram
      && !capabilities.matrix ? (
        <p className="footer-note">
          {zh
            ? "当前代表暂未开放可绑定的私聊渠道。"
            : "This representative has no linkable private-chat channel yet."}
        </p>
      ) : null}

      {instruction ? (
        <div className="status-banner status-success">
          <strong>
            {instruction.provider === "telegram"
              ? zh
                ? `复制命令并发送给 ${
                    instruction.telegramBot
                      ? telegramBotLabel(instruction.telegramBot)
                      : "当前代表的 Telegram Bot"
                  }`
                : `Copy and send this command to ${
                    instruction.telegramBot
                      ? telegramBotLabel(instruction.telegramBot)
                      : "this representative's Telegram Bot"
                  }`
              : zh
                ? `请用 ${instruction.expectedProviderSubject ?? "已填写的 Matrix 账号"} 在与 ${
                    instruction.matrixEndpoint?.matrixUserId
                    ?? matrixEndpoint?.matrixUserId
                    ?? "目标代表"
                  } 的未加密私聊中发送以下命令`
                : `Use ${
                    instruction.expectedProviderSubject
                    ?? "the Matrix account you entered"
                  } to send this command in the unencrypted direct room with ${
                    instruction.matrixEndpoint?.matrixUserId
                    ?? matrixEndpoint?.matrixUserId
                    ?? "the representative destination"
                  }`}
          </strong>
          <pre className="artifact-preview">{instruction.command}</pre>
          <div className="chip-row">
            <button
              className="button-secondary"
              disabled={copiedCommand === instruction.command}
              onClick={() => void copyBindingCommand()}
              type="button"
            >
              {copiedCommand === instruction.command
                ? zh
                  ? "已复制"
                  : "Copied"
                : zh
                  ? "复制命令"
                  : "Copy command"}
            </button>
            {instruction.provider === "telegram"
            && instruction.telegramBot?.username ? (
              <a
                className="button-secondary"
                href={telegramBotUrl(
                  instruction.telegramBot,
                  representativeSlug,
                )}
                rel="noreferrer"
                target="_blank"
              >
                {zh
                  ? `打开 ${telegramBotLabel(instruction.telegramBot)}`
                  : `Open ${telegramBotLabel(instruction.telegramBot)}`}
              </a>
            ) : null}
            {bindingPollPaused ? (
              <button
                className="button-secondary"
                onClick={() => {
                  setError(null);
                  setBindingPollPaused(false);
                  setBindingPollAttempt((current) => current + 1);
                }}
                type="button"
              >
                {zh
                  ? "重新检查绑定状态"
                  : "Check binding status again"}
              </button>
            ) : null}
          </div>
          <p className="footer-note">
            {zh ? "一次性命令将在 " : "This one-time command expires at "}
            {new Date(instruction.expiresAt).toLocaleString(
              zh ? "zh-CN" : "en-US",
            )}
            {zh ? " 失效。" : "."}
          </p>
        </div>
      ) : null}

      {notice ? <div className="status-banner status-success">{notice}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}
    </div>
  );
}

function bindingKey(binding: BindingSnapshot): string {
  return [
    binding.provider,
    binding.providerSubject,
    binding.issuer,
    binding.connectionId,
  ].join(":");
}

function telegramBindingTarget(
  binding: BindingSnapshot,
  currentBot: TelegramBotEndpoint | null,
): string {
  return currentBot?.botId === binding.connectionId
    ? telegramBotLabel(currentBot)
    : binding.connectionId
      ? `Bot ID ${binding.connectionId}`
      : "Legacy Telegram binding";
}

function telegramBotLabel(bot: TelegramBotEndpoint): string {
  return bot.username ? `@${bot.username}` : `Bot ID ${bot.botId}`;
}

function telegramBotUrl(
  bot: TelegramBotEndpoint,
  representativeSlug: string,
): string {
  if (!bot.username) return "https://t.me";
  const payload = `rep_${representativeSlug}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(payload)
    ? `https://t.me/${bot.username}?start=${payload}`
    : `https://t.me/${bot.username}`;
}

async function extractError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error || response.statusText;
}

async function fetchBindingState(
  representativeSlug: string,
): Promise<BindingStatePayload> {
  const response = await fetch(
    `/reps/${representativeSlug}/identity-bindings`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new BindingRequestError(
      response.status,
      await extractError(response),
    );
  }
  return response.json() as Promise<BindingStatePayload>;
}

async function fetchBindingChallengeState(
  representativeSlug: string,
  challengeId: string,
): Promise<BindingChallengeState> {
  const search = new URLSearchParams({ challengeId });
  const response = await fetch(
    `/reps/${representativeSlug}/identity-bindings?${search.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new BindingRequestError(
      response.status,
      await extractError(response),
    );
  }
  return response.json() as Promise<BindingChallengeState>;
}

class BindingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BindingRequestError";
  }
}
