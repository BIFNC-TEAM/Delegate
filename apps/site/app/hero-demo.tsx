"use client";

import { useRef, useState } from "react";
import { copyFor, type MarketingLocale } from "./marketing-copy";

export function HeroDemo({ locale }: { locale: MarketingLocale }) {
  const t = copyFor(locale);
  const [decision, setDecision] = useState<"approve" | "decline" | null>(null);
  const [view, setView] = useState<"pending" | "done">("pending");
  const [replay, setReplay] = useState(0);
  const doneTab = useRef<HTMLButtonElement>(null);
  const taskVisible = decision ? view === "done" : view === "pending";
  function decide(value: "approve" | "decline") {
    setDecision(value);
    setView("done");
    doneTab.current?.focus({ preventScroll: true });
  }
  return (
    <div className="hero-stage" id="hero-demo">
      <div className="stage-caption">
        <span>
          {t(
            "接待与审批 · 交互示例",
            "Reception & decisions · Interactive demo",
          )}
        </span>
        <button
          className="replay-demo"
          onClick={() => {
            setDecision(null);
            setView("pending");
            setReplay(replay + 1);
          }}
        >
          {t("重播", "Replay")}
        </button>
      </div>
      <section
        className="conversation"
        aria-label={t(
          "客户与 Lin 对外代理的会话示例",
          "Example conversation with Lin’s AI representative",
        )}
      >
        <div className="conversation-head">
          <span className="avatar-letter">L</span>
          <div>
            <strong>{t("Lin 的对外代理", "Lin’s representative")}</strong>
            <span>
              {t("产品战略 · 创业咨询", "Product strategy · Startup advice")}
            </span>
          </div>
          <span className="ai-label">AI · {t("接待客户", "Reception")}</span>
        </div>
        <div className="chat-content" key={replay}>
          <div className="chat-message visitor">
            {t(
              "我们是一个 20 人团队，产品已上线，想咨询下一阶段的增长方向。",
              "We’re a team of 20 with a live product. We’d love some advice on our next stage of growth.",
            )}
          </div>
          <div className="chat-message assistant">
            <span className="chat-d">D</span>
            <div>
              {t(
                "可以先帮你梳理产品定位、目标客户和增长思路。你希望重点讨论什么？",
                "I can help clarify your positioning, target customers, and growth options. What would you like to focus on?",
              )}
            </div>
          </div>
          <div className="chat-message visitor">
            {t(
              "想请 Lin 本人参加一次产品评审，下周三 14:00，约 1 小时，可以吗？",
              "Could Lin join a product review next Wednesday at 14:00, for about an hour?",
            )}
          </div>
          <div className="chat-message assistant">
            <span className="chat-d">D</span>
            <div>
              {t(
                "这需要 Lin 本人确认。我已将评审邀请提交给他，时间以他的确认结果为准。",
                "Lin needs to confirm that personally. I’ve passed on your invitation; the time is subject to his confirmation.",
              )}
            </div>
          </div>
          <div className="intake">
            <span className="intake-check">↗</span>
            <div>
              <strong>
                {t("产品评审邀请已提交", "Review invitation submitted")}
              </strong>
              <span>
                {t(
                  "交由 Lin 本人确认是否参加",
                  "Waiting for Lin’s personal decision",
                )}
              </span>
            </div>
            <span className="soft-label">
              {decision ? t("本人已处理", "Reviewed") : t("待审批", "Pending")}
            </span>
          </div>
        </div>
        <div className="chat-bottom">
          <span>
            {t("日常沟通由对外代理接待", "AI handles everyday requests")}
          </span>
          <span>{t("需要决策时提交本人", "You make the decisions")}</span>
        </div>
      </section>
      <section
        className="owner-approval"
        aria-label={t("Lin 的待审批事项演示", "Lin’s decision queue demo")}
      >
        <div className="approval-account">
          <span className="account-avatar">L</span>
          <div>
            <strong>{t("Lin 的工作台", "Lin’s workspace")}</strong>
            <span>{t("本人账号", "Personal account")}</span>
          </div>
          <span className="account-label">
            {t("创建者视角", "Creator view")}
          </span>
        </div>
        <div className="approval-intro">
          <span className="approval-symbol" aria-hidden="true">
            ✓
          </span>
          <div>
            <h3>
              {t(
                "关键决定，由你亲自拍板。",
                "The important decisions stay yours.",
              )}
            </h3>
            <p>
              {t(
                "需要你确认的事项，自动进入待审批列表。",
                "Requests that need your judgment arrive in your decision queue.",
              )}
            </p>
          </div>
        </div>
        <div
          className="approval-tabs"
          role="group"
          aria-label={t("演示审批列表", "Demo decision queues")}
        >
          <button
            aria-pressed={view === "pending"}
            onClick={() => setView("pending")}
          >
            {t("待审批", "Pending")} <span>{decision ? 0 : 1}</span>
          </button>
          <button
            ref={doneTab}
            aria-pressed={view === "done"}
            onClick={() => setView("done")}
          >
            {t("已处理", "Completed")} <span>{decision ? 1 : 0}</span>
          </button>
        </div>
        <div className="approval-list">
          {taskVisible ? (
            <article className="approval-task">
              <div className="approval-task-meta">
                <span>{t("会面邀请", "Meeting invitation")}</span>
                <span
                  className="approval-status"
                  data-decision={decision ?? ""}
                >
                  {!decision
                    ? t("等待你确认", "Awaiting your decision")
                    : decision === "approve"
                      ? t("Lin 已同意", "Lin accepted")
                      : t("Lin 已婉拒", "Lin declined")}
                </span>
              </div>
              <h4>
                {t(
                  "是否接受这次产品评审邀请？",
                  "Accept this product review invitation?",
                )}
              </h4>
              <dl>
                <div>
                  <dt>{t("客户", "Client")}</dt>
                  <dd>{t("20 人产品团队", "20-person product team")}</dd>
                </div>
                <div>
                  <dt>{t("时间", "When")}</dt>
                  <dd>
                    {t(
                      "下周三 14:00 · 1 小时",
                      "Next Wednesday, 14:00 · 1 hour",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("需求", "Need")}</dt>
                  <dd>
                    {t(
                      "讨论已上线产品的下一阶段增长方向",
                      "Discuss the next stage of growth for a live product",
                    )}
                  </dd>
                </div>
              </dl>
              {!decision ? (
                <div className="approval-actions">
                  <button
                    className="approve-button"
                    onClick={() => decide("approve")}
                  >
                    {t("同意邀请", "Accept invitation")}
                  </button>
                  <button
                    className="decline-button"
                    onClick={() => decide("decline")}
                  >
                    {t("暂不接受", "Decline for now")}
                  </button>
                </div>
              ) : (
                <p
                  className="approval-result"
                  data-decision={decision}
                  role="status"
                >
                  {decision === "approve"
                    ? t(
                        "已记录：Lin 同意参加本次评审。事项已移至「已处理」。",
                        "Recorded: Lin accepted the review. The request is now completed.",
                      )
                    : t(
                        "已记录：Lin 暂不接受本次邀请。事项已移至「已处理」。",
                        "Recorded: Lin declined this invitation. The request is now completed.",
                      )}
                </p>
              )}
            </article>
          ) : (
            <div className="approval-empty">
              <span aria-hidden="true">✓</span>
              <strong>
                {decision
                  ? t("当前没有待审批事项", "No pending requests")
                  : t("暂无已处理事项", "No completed requests yet")}
              </strong>
              <p>
                {decision
                  ? t(
                      "这次评审邀请已处理，可切换到「已处理」查看。",
                      "Switch to Completed to see Lin’s decision.",
                    )
                  : t(
                      "Lin 作出决定后，事项会出现在这里。",
                      "Requests will appear here after Lin makes a decision.",
                    )}
              </p>
            </div>
          )}
        </div>
        <p className="approval-demo-note">
          {t(
            "点击按钮体验审批 · 仅为演示，不会操作真实账号",
            "Try a decision · This demo does not change a real account",
          )}
        </p>
      </section>
    </div>
  );
}
