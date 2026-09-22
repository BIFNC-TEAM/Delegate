import React, { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AuthError, AuthFlow, readSocialCallback, wechatCallbackUri, identifier, type Event, type Identifier, type Requester } from "./flow";
import "./styles.css";

declare const __MOCK_SMS_ORIGIN__: string;
declare const __WECHAT_LOCAL_CALLBACK_URI__: string;
const params = new URLSearchParams(location.search);
const appId = params.get("app_id") || sessionStorage.getItem("delegate.auth.appId") || "";
if (appId) sessionStorage.setItem("delegate.auth.appId", appId);
const mockOrigin = ["127.0.0.1", "localhost"].includes(location.hostname) ? __MOCK_SMS_ORIGIN__ : "";
const request: Requester = async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
  const response = await fetch(path, { method, signal: AbortSignal.timeout(30_000), credentials: "same-origin", headers: {
    "Accept-Language": "zh-CN", ...(appId ? { "Logto-App-Id": appId } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new AuthError(typeof result.code === "string" ? result.code : "request_failed", typeof result.message === "string" ? result.message : "请求未完成", response.status);
  return result as T;
};
async function resolveCode(code: string, id: Identifier, event: Event) {
  if (!mockOrigin || id.type !== "phone") return code;
  const response = await fetch(`${location.origin}/__delegate_mock_sms/resolve`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: id.value, type: event, testCode: code }) });
  const data = await response.json();
  if (!response.ok || typeof data.code !== "string") throw new AuthError("local_code_invalid", data.message || "测试验证码不正确或已过期");
  return data.code;
}
const flow = new AuthFlow(request, (url) => {
  const destination = new URL(url, location.origin);
  if (!["http:", "https:"].includes(destination.protocol)) throw new Error("Unsafe redirect");
  location.assign(destination.toString());
}, resolveCode);
type Settings = { socialConnectors?: { id: string; target: string; logo: string; name?: Record<string, string> }[]; termsOfUseUrl?: string; privacyPolicyUrl?: string; captchaPolicy?: { enabled?: boolean }; signIn?: { methods?: { identifier: string; password?: boolean }[] } };

function App() {
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot);
  const [settings, setSettings] = useState<Settings>();
  const [mode, setMode] = useState<"sms" | "password">("sms");
  const [account, setAccount] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [tick, setTick] = useState(Date.now());
  const [terms, setTerms] = useState(false);
  const [bootError, setBootError] = useState("");
  const emailEnabled = settings?.signIn?.methods?.some((method) => method.identifier === "email" && method.password === true) ?? false;
  const wechat = settings?.socialConnectors?.find((item) => item.target === "wechat");
  const remaining = Math.min(60, Math.max(0, Math.ceil((state.cooldownUntil - tick) / 1000)));
  const busy = state.busy || !settings || !!settings.captchaPolicy?.enabled;
  useEffect(() => { const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setPassword(""); setConfirm(""); setCode(""); }, [state.stage]);
  useEffect(() => {
    void (async () => {
      try {
        const config = await request<Settings>(`/api/.well-known/sign-in-exp${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`);
        setSettings(config);
        if (config.captchaPolicy?.enabled) { setBootError("当前环境要求验证码防护，请管理员接入对应的人机验证组件后使用此页面。"); return; }
        if (location.pathname.startsWith("/callback/")) {
          const raw = sessionStorage.getItem("delegate.auth.social");
          sessionStorage.removeItem("delegate.auth.social");
          const saved = readSocialCallback(raw, location.pathname, params);
          await flow.run(() => flow.wechatCallback(saved.connectorId, saved.verificationId, { code: saved.code, state: saved.state }));
          history.replaceState(null, "", "/sign-in");
        } else {
          await flow.run(() => flow.reset(location.pathname.includes("forgot-password") ? "reset" : "login"));
        }
      } catch (error) { setBootError(error instanceof Error ? error.message : "登录页面加载失败，请刷新重试"); }
    })();
  }, []);
  const invoke = (fn: () => Promise<void>) => { void flow.run(fn); };
  const submitLogin = (event: React.FormEvent) => {
    event.preventDefault();
    if (state.stage === "login" && (settings?.termsOfUseUrl || settings?.privacyPolicyUrl) && !terms) { setBootError("请先阅读并同意用户协议和隐私政策"); return; }
    setBootError("");
    invoke(async () => {
      if (mode === "password" && identifier(account).type === "email" && !emailEnabled) {
        throw new AuthError("local_email_unavailable", "邮箱登录暂未启用，请先使用手机号或微信登录");
      }
      await (mode === "sms" ? flow.codeLogin(account, code) : flow.passwordLogin(account, password));
    });
  };
  const beginWechat = () => invoke(async () => {
    if (!wechat) return;
    if ((settings?.termsOfUseUrl || settings?.privacyPolicyUrl) && !terms) throw new AuthError("local_terms", "请先阅读并同意用户协议和隐私政策");
    const redirectUri = wechatCallbackUri(location.origin, wechat.id, __WECHAT_LOCAL_CALLBACK_URI__);
    const nonce = crypto.randomUUID();
    const result = await flow.startWechat(wechat.id, nonce, redirectUri);
    sessionStorage.setItem("delegate.auth.social", JSON.stringify({ connectorId: wechat.id, state: nonce, verificationId: result.verificationId, createdAt: Date.now() }));
    const url = new URL(result.authorizationUri);
    if (url.origin !== "https://open.weixin.qq.com" || url.pathname !== "/connect/qrconnect"
      || url.searchParams.get("redirect_uri") !== redirectUri || url.searchParams.get("state") !== nonce) throw new Error("Unexpected WeChat authorization URL");
    location.assign(url.toString());
  });
  const codeField = <div className="code-row"><label><span>验证码</span><input aria-label="验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="6 位验证码" /></label><button type="button" className="text-button" disabled={busy || remaining > 0} onClick={() => invoke(async () => { if (state.stage === "reset" && identifier(account).type === "email" && !emailEnabled) throw new AuthError("local_email_unavailable", "邮箱验证暂未启用，请使用已绑定手机号"); await flow.sendCode(account); })}>{remaining ? `${remaining} 秒后重发` : "获取验证码"}</button></div>;
  const passwordField = <label><span>密码</span><input type="password" autoComplete={state.stage === "onboarding" || state.stage === "reset-password" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" maxLength={128} /></label>;
  const profile = <><h1>创建密码，设置昵称</h1><p className="muted">账号已创建。现在补充资料，也可以稍后在个人信息中设置。</p>{passwordField}<p className="hint">至少 8 个字符，包含大小写字母、数字、特殊字符中的至少三种。</p><label><span>昵称</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="nickname" placeholder="你希望别人如何称呼你" /></label><div className="actions"><button disabled={busy} onClick={() => invoke(() => flow.completeProfile(name, password))}>确定</button><button disabled={busy} className="secondary" onClick={() => invoke(() => flow.completeProfile("", "", true))}>暂时跳过</button></div></>;
  return <main><section className="auth-card"><a className="brand" href="#" onClick={(e) => e.preventDefault()}><span>D</span>Delegate</a><p className="eyebrow">你的对外代理，从这里开始</p>
    {mockOrigin && <div className="mock-note" role="status">本地测试环境 · 短信验证码 123456 · 不发送真实短信</div>}
    {(state.error || bootError) && <div className="error" role="alert">{bootError || state.error}{!settings?.captchaPolicy?.enabled && <button className="text-button" disabled={busy} onClick={() => { setBootError(""); invoke(() => flow.reset()); }}>重新开始登录</button>}</div>}
    {(state.stage === "login" || state.stage === "link") && <>
      {state.stage === "link" && <><h1>关联已有账号</h1><p className="muted">验证原账号后，将微信关联到它。原工作区与资料将保留。</p></>}
      <div className="tabs" role="tablist" aria-label="登录方式"><button role="tab" aria-selected={mode === "sms"} className={mode === "sms" ? "selected" : ""} disabled={busy} onClick={() => { setMode("sms"); setPassword(""); }}>验证码登录</button><button role="tab" aria-selected={mode === "password"} className={mode === "password" ? "selected" : ""} disabled={busy} onClick={() => { setMode("password"); setCode(""); }}>账号登录</button></div>
      <form onSubmit={submitLogin}><label><span>{mode === "sms" ? "手机号" : "手机号或邮箱"}</span><div className="phone-row">{mode === "sms" && <span className="country">+86</span>}<input value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="username" inputMode={mode === "sms" ? "tel" : "text"} placeholder={mode === "sms" ? "请输入手机号" : "请输入手机号或邮箱"} /></div></label>
      {mode === "sms" ? codeField : <>{passwordField}{state.stage === "login" && <button className="text-button forgot" type="button" disabled={busy} onClick={() => invoke(() => flow.reset("reset"))}>忘记密码？</button>}</>}
      {state.stage === "login" && <p className="hint">{mode === "sms" ? "未注册的手机号验证后将创建账号。" : emailEnabled ? "邮箱可在设置的个人信息中验证绑定。" : "请使用手机号登录；邮箱登录暂未启用。"}</p>}
      {state.stage === "login" && (settings?.termsOfUseUrl || settings?.privacyPolicyUrl) && <label className="terms"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />我已阅读并同意 {settings.termsOfUseUrl && <a href={settings.termsOfUseUrl} target="_blank" rel="noreferrer">用户协议</a>} {settings.privacyPolicyUrl && <a href={settings.privacyPolicyUrl} target="_blank" rel="noreferrer">隐私政策</a>}</label>}
      <button className="primary full" disabled={busy || !!bootError && !!settings?.captchaPolicy?.enabled}>{busy ? "处理中…" : state.stage === "link" ? "验证并关联" : mode === "sms" ? "登录 / 注册" : "登录"}</button></form>
      {state.stage === "login" && wechat && <><div className="divider"><span>或</span></div><button type="button" className="wechat" aria-label="微信登录" title="微信登录" disabled={busy} onClick={beginWechat}><img src={wechat.logo} alt="" aria-hidden="true" /></button></>}
      {state.stage === "link" && <button className="text-button back" disabled={busy} onClick={() => invoke(() => flow.reset())}>取消关联，返回登录</button>}
    </>}
    {state.stage === "wechat-choice" && <><h1>欢迎使用 Delegate</h1><p className="muted">微信授权成功，请选择如何继续。此时尚未创建业务工作区。</p><div className="choices"><button disabled={busy} onClick={() => invoke(() => flow.chooseNew())}>我是新用户，创建账号</button><button className="secondary" disabled={busy} onClick={() => flow.chooseExisting()}>我已有账号，关联已有账号</button></div><p className="hint">已有账号请先验证原账号，避免创建重复工作区。</p></>}
    {state.stage === "onboarding" && profile}
    {state.stage === "reset" && <><h1>重置登录密码</h1><p className="muted">{emailEnabled ? "使用已绑定的手机号或邮箱验证身份。" : "使用已绑定的中国大陆手机号验证身份。"}</p><label><span>{emailEnabled ? "已绑定手机号或邮箱" : "已绑定手机号"}</span><input value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="username" placeholder={emailEnabled ? "请输入手机号或邮箱" : "请输入中国大陆手机号"} /></label>{codeField}<button className="full" disabled={busy} onClick={() => invoke(() => flow.codeLogin(account, code))}>验证并继续</button><button className="text-button back" disabled={busy} onClick={() => invoke(() => flow.reset())}>返回登录</button></>}
    {state.stage === "reset-password" && <><h1>设置新密码</h1>{passwordField}<label><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label><p className="hint">至少 8 个字符，包含四类字符中的至少三种。</p><button className="full" disabled={busy} onClick={() => invoke(async () => { if (password !== confirm) throw new AuthError("password_invalid", "两次输入的密码不一致"); await flow.resetPassword(password); })}>确认重置</button></>}
    {state.stage === "reset-success" && <><h1>密码已重置</h1><p className="muted">请使用新密码重新登录。</p><button className="full" onClick={() => invoke(() => { setMode("password"); return flow.reset(); })}>返回登录</button></>}
    {state.stage === "mfa" && <><h1>验证身份</h1><p className="muted">请输入身份验证器中的动态验证码。</p><label><span>动态验证码</span><input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></label><button className="full" disabled={busy} onClick={() => invoke(() => flow.verifyMfa(code))}>验证并继续</button></>}
  </section><footer>Delegate · 安全地连接你的账号与工作区</footer></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
