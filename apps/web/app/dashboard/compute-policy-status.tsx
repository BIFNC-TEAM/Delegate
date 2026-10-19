"use client";

import { useEffect, useState } from "react";
import type { RepresentativeComputePolicyView } from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type Compute = NonNullable<RepresentativeComputePolicyView["runtimeCeiling"]>;
type Props = { representativeSlug: string; locale: Locale; savedRevision: string; draft?: Compute | undefined };

export function ComputePolicyStatus({ representativeSlug, locale, savedRevision, draft }: Props) {
  const [result, setResult] = useState<{ key: string; view: RepresentativeComputePolicyView } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const requestKey = JSON.stringify([representativeSlug, savedRevision, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false); setResult(null);
    void fetch(`/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/compute/policy-view`, {
      cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("policy_unavailable");
      const next = await response.json() as RepresentativeComputePolicyView;
      if (!controller.signal.aborted) setResult({ key: requestKey, view: next });
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [representativeSlug, requestKey]);
  return <div className="field-stack field-span-full">
    <ComputePolicySummary view={result?.key === requestKey ? result.view : null} locale={locale} draft={draft} error={error} loading={loading || Boolean(result && result.key !== requestKey)} />
    <div><button className="button-secondary" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>
      {locale === "zh" ? "刷新生效策略" : "Refresh policy"}
    </button> <a className="button-secondary" href={`/dashboard?view=approvals&rep=${encodeURIComponent(representativeSlug)}`}>
      {locale === "zh" ? "查看审批原因" : "View approval reasons"}
    </a></div>
  </div>;
}

/** Separate rendering keeps loading/unavailable states testable without a live app. */
export function ComputePolicySummary({ view, locale, draft, error = false, loading = false }: {
  view: RepresentativeComputePolicyView | null; locale: Locale; draft?: Compute | undefined; error?: boolean; loading?: boolean;
}) {
  const zh = locale === "zh";
  const mode = { allow: zh ? "默认放行" : "Allow", ask: zh ? "需审批" : "Ask", deny: zh ? "禁止" : "Deny" };
  const names = zh ? { exec: "一次性命令", read: "读取工作区", write: "写入工作区", process: "长期进程", browser: "浏览公开网页", mcp: "外部 MCP" }
    : { exec: "Command", read: "Read workspace", write: "Write workspace", process: "Process", browser: "Public browser", mcp: "External MCP" };
  const ceiling = view?.state === "ready" ? view.runtimeCeiling : null;
  return <>
    <strong>{zh ? "当前发布版本的执行上限" : "Current published execution limits"}</strong>
    <p className="field-hint">{zh
      ? "页面选项是编辑值。保存后的收紧即时生效；放宽权限需发布新版本。下方显示已发布权限与当前收紧的交集，每次调用仍会检查具体请求。"
      : "Form options are editing values. Saved restrictions apply immediately; broader permissions require publishing. Below is the published ceiling after live restrictions, rechecked for each request."}</p>
    {loading ? <p role="status">{zh ? "正在读取生效策略…" : "Loading policy…"}</p>
      : error || !view || view.state === "unavailable" ? <p role="status">{zh ? "暂时无法读取生效策略，不能根据编辑值判断是否免审批。" : "Policy unavailable; editing values cannot establish approval requirements."}</p>
      : view.state === "unpublished" ? <p>{zh ? "尚未发布，暂无公开运行权限。" : "Not published; no public execution authority yet."}</p>
      : ceiling ? <>
        <div className="chip-row">
          <span className="chip">v{view.publishedVersion?.number}</span>
          <span className={ceiling.enabled ? "chip chip-safe" : "chip chip-danger"}>{ceiling.enabled ? zh ? "已启用" : "Enabled" : zh ? "不可执行" : "Disabled"}</span>
          <span className="chip">{zh ? "默认策略：" : "Default: "}{mode[ceiling.defaultPolicyMode]}</span>
        </div>
        <p className="field-hint">{view.codeExecution?.available === false
          ? zh ? "当前通用代码执行不可用：任意命令和长期进程暂不开放。受限 Python 需通过会话预检和当前权限检查，仅支持单进程、标准库、无网络，最长 30 秒；公开浏览器仍按单独授权运行。" : "General code execution is currently unavailable: arbitrary commands and persistent processes remain closed. Restricted Python requires session preflight and current authorization: one process, standard library, no network, up to 30 seconds. Public browsing uses its separate authorization."
          : view.codeExecution?.available === true
            ? zh ? "代码仍须通过每次请求的权限与执行预检。" : "Each code request still requires authorization and execution preflight."
            : zh ? "服务端尚未报告代码执行配置状态，不能仅凭放行选项确认可执行。" : "The server has not reported code runtime readiness; Allow alone does not establish execution availability."}</p>
        <div className="setup-grid">{(Object.keys(names) as Array<keyof typeof names>).map(capability => <div className="field-stack" key={capability}>
          <span>{names[capability]}</span>
          <strong>{mode[ceiling.enabled ? ceiling.capabilityModes[capability] : "deny"]}</strong>
          {draft && draft.capabilityModes[capability] !== (ceiling.enabled ? ceiling.capabilityModes[capability] : "deny")
            ? <small className="field-hint">{zh ? "页面编辑值：" : "Editing value: "}{mode[draft.capabilityModes[capability]]}</small> : null}
        </div>)}</div>
        <p className="field-hint">{zh ? `自动执行上限：${ceiling.autoApproveTokenLimit} Tokens。0 表示正估算请求仍需审批。` : `Auto-execution limit: ${ceiling.autoApproveTokenLimit} tokens. Zero still requires approval for positive estimates.`}</p>
        <p className="field-hint">{zh
          ? "显示放行也可能因单次 Token 上限、MCP 绑定审批、浏览器写操作或平台／组织／访客规则进入审批；服务暂停或权限不足仍会拦截。审批记录中的实际命中原因是该次请求的依据；本页不预先批准操作。在途任务可能固定在旧发布版本。"
          : "Allow may still require approval due to the token limit, MCP binding, browser mutation or platform/organization/visitor rules. Paused service or insufficient access still blocks execution. The approval record explains the actual request. This view grants no approval; in-flight tasks may remain pinned to an older version."}</p>
        <small className="field-hint">{zh ? "读取时间：" : "Read at: "}{view.asOf}</small>
      </> : null}
  </>;
}
