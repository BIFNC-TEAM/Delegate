export type Event = "SignIn" | "Register" | "ForgotPassword";
export type Identifier = { type: "phone" | "email" | "username"; value: string };
export type Requester = <T = Record<string, unknown>>(path: string, method?: string, body?: unknown) => Promise<T>;
export type Stage = "login" | "wechat-choice" | "link" | "onboarding" | "reset" | "reset-password" | "reset-success" | "mfa";
export type State = { stage: Stage; busy: boolean; error: string; cooldownUntil: number; created: boolean };
export class AuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function identifier(value: string, phoneOnly = false): Identifier {
  const text = value.trim();
  if (/^(?:\+?86)?1[3-9]\d{9}$/u.test(text)) return { type: "phone", value: `86${text.replace(/^\+?86/u, "")}` };
  if (phoneOnly) throw new AuthError("phone_invalid", "请输入中国大陆 11 位手机号");
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return { type: "email", value: text };
  if (text && !/\s/u.test(text)) return { type: "username", value: text };
  throw new AuthError("identifier_invalid", "请输入手机号、邮箱或已有用户名");
}
export function passwordError(value: string): string | null {
  if (value.length < 8 || value.length > 128) return "密码长度须为 8–128 个字符";
  if ([/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((rule) => rule.test(value)).length < 3) return "密码须包含大写字母、小写字母、数字和特殊字符中的至少三种";
  return null;
}
export function messageFor(error: unknown): string {
  if (!(error instanceof AuthError)) return "网络暂时不可用，请稍后重试";
  const messages: Record<string, string> = {
    "user.user_not_exist": "未找到该账号，请核对登录信息",
    "session.invalid_credentials": "账号或密码不正确",
    "user.invalid_password": "账号或密码不正确",
    "verification_code.code_mismatch": "验证码不正确，请重新输入",
    "verification_code.expired": "验证码已过期，请重新获取",
    "verification_code.not_found": "请先获取验证码",
    "verification_code.exceed_max_try": "尝试次数过多，请重新获取验证码",
    "user.social_account_exists_in_profile": "此微信已关联其他账号，不能覆盖或自动合并账号",
    "user.identity_already_in_use": "此微信已关联其他账号，请使用原账号登录",
    "session.verification_session_not_found": "验证会话已失效，请重新开始登录",
    "session.not_found": "登录会话已失效，请从网站重新进入",
    "user.phone_already_in_use": "此手机号已属于其他账号，请登录已有账号",
    "user.email_already_in_use": "此邮箱已属于其他账号，请登录已有账号",
  };
  if (error.status === 429) return "操作过于频繁，请稍后再试";
  return messages[error.code] ?? (error.code.endsWith("_invalid") || error.code.startsWith("local_") ? error.message : "暂时无法完成，请核对输入后重试");
}

export function readSocialCallback(raw: string | null, pathname: string, params: URLSearchParams, now = Date.now()) {
  let saved;
  try { saved = raw ? JSON.parse(raw) : null; } catch { throw new AuthError("local_social_state", "微信授权会话已失效，请重新登录"); }
  if (!saved || typeof saved.state !== "string" || !saved.state || typeof saved.verificationId !== "string" || !saved.verificationId
    || typeof saved.connectorId !== "string" || !saved.connectorId || typeof saved.createdAt !== "number"
    || !Number.isFinite(saved.createdAt) || saved.createdAt > now || now - saved.createdAt > 600_000
    || params.get("state") !== saved.state || pathname !== `/callback/${saved.connectorId}`) {
    throw new AuthError("local_social_state", "微信授权会话已失效，请重新登录");
  }
  if (params.get("error") || !params.get("code")) throw new AuthError("local_social_cancelled", "微信授权已取消，请重新选择登录方式");
  return { connectorId: saved.connectorId as string, verificationId: saved.verificationId as string, code: params.get("code")!, state: saved.state as string };
}

export class AuthFlow {
  state: State = { stage: "login", busy: false, error: "", cooldownUntil: 0, created: false };
  private listeners = new Set<() => void>();
  private challenge: { id: string; identifier: Identifier; event: Event } | undefined;
  private socialId: string | undefined;
  constructor(readonly request: Requester, readonly navigate: (url: string) => void,
    readonly resolveCode: (code: string, id: Identifier, event: Event) => Promise<string> = async (code) => code) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  private set(values: Partial<State>) { this.state = { ...this.state, ...values }; for (const fn of this.listeners) fn(); }
  async run(operation: () => Promise<void>) {
    if (this.state.busy) return;
    this.set({ busy: true, error: "" });
    try { await operation(); } catch (error) { this.set({ error: messageFor(error) }); }
    finally { this.set({ busy: false }); }
  }
  async reset(stage: "login" | "reset" = "login") {
    this.challenge = undefined; this.socialId = undefined;
    await this.request("/api/experience", "PUT", { interactionEvent: stage === "reset" ? "ForgotPassword" : "SignIn" });
    this.set({ stage, created: false, error: "", cooldownUntil: 0 });
  }
  async sendCode(value: string) {
    if (Date.now() < this.state.cooldownUntil) throw new AuthError("local_cooldown", "请等待倒计时结束后再获取验证码");
    const id = identifier(value, true);
    if (this.state.stage === "reset" && id.type === "username") throw new AuthError("identifier_invalid", "重置密码需要已绑定的手机号或邮箱");
    const event: Event = this.state.stage === "reset" ? "ForgotPassword" : "SignIn";
    const result = await this.request<{ verificationId: string }>("/api/experience/verification/verification-code", "POST", { identifier: id, interactionEvent: event });
    if (!result.verificationId) throw new Error("Invalid verification response");
    this.challenge = { id: result.verificationId, identifier: id, event };
    this.set({ cooldownUntil: Date.now() + 60_000 });
  }
  private async identify(id: string) { return this.request("/api/experience/identification", "POST", { verificationId: id }); }
  private async submit() {
    try {
      const result = await this.request<{ redirectTo?: string }>("/api/experience/submit", "POST");
      if (this.state.stage === "reset-password") { this.set({ stage: "reset-success" }); return; }
      if (!result.redirectTo) throw new Error("Missing redirect");
      this.navigate(result.redirectTo);
    } catch (error) {
      if (error instanceof AuthError && /mfa.*required|mfa.*not_verified|mfa.require_mfa_verification/u.test(error.code)) { this.set({ stage: "mfa" }); return; }
      throw error;
    }
  }
  async codeLogin(value: string, code: string) {
    const id = identifier(value, true);
    if (!this.challenge || id.type !== this.challenge.identifier.type || id.value !== this.challenge.identifier.value) throw new AuthError("identifier_invalid", "手机号或邮箱已改变，请重新获取验证码");
    if (!/^\d{6}$/u.test(code)) throw new AuthError("code_invalid", "请输入 6 位验证码");
    const result = await this.request<{ verificationId: string }>("/api/experience/verification/verification-code/verify", "POST", {
      identifier: id, verificationId: this.challenge.id, code: await this.resolveCode(code, id, this.challenge.event),
    });
    try { await this.identify(result.verificationId); }
    catch (error) {
      if (error instanceof AuthError && error.code === "user.user_not_exist" && this.state.stage === "login") {
        await this.register(result.verificationId); return;
      }
      throw error;
    }
    if (this.state.stage === "reset") { this.set({ stage: "reset-password" }); return; }
    await this.finishExisting();
  }
  async passwordLogin(value: string, password: string) {
    if (!password) throw new AuthError("password_invalid", "请输入密码");
    const result = await this.request<{ verificationId: string }>("/api/experience/verification/password", "POST", { identifier: identifier(value), password });
    await this.identify(result.verificationId);
    await this.finishExisting();
  }
  private async finishExisting() {
    if (this.state.stage === "link") {
      if (!this.socialId) throw new Error("Missing social proof");
      await this.request("/api/experience/profile", "POST", { type: "social", verificationId: this.socialId });
    }
    await this.submit();
  }
  async startWechat(connectorId: string, state: string, redirectUri: string) {
    await this.reset();
    return this.request<{ verificationId: string; authorizationUri: string }>(`/api/experience/verification/social/${encodeURIComponent(connectorId)}/authorization-uri`, "POST", { state, redirectUri });
  }
  async wechatCallback(connectorId: string, verificationId: string, data: { code: string; state: string }) {
    const result = await this.request<{ verificationId: string }>(`/api/experience/verification/social/${encodeURIComponent(connectorId)}/verify`, "POST", { verificationId, connectorData: data });
    this.socialId = result.verificationId;
    try { await this.identify(result.verificationId); }
    catch (error) {
      if (error instanceof AuthError && error.code === "user.user_not_exist") { this.set({ stage: "wechat-choice" }); return; }
      throw error;
    }
    await this.submit();
  }
  chooseExisting() { if (!this.socialId) throw new Error("Missing social proof"); this.challenge = undefined; this.set({ stage: "link", cooldownUntil: 0 }); }
  async chooseNew() { if (!this.socialId) throw new Error("Missing social proof"); await this.register(this.socialId); }
  private async register(verificationId: string) {
    await this.request("/api/experience/interaction-event", "PUT", { interactionEvent: "Register" });
    await this.identify(verificationId);
    this.set({ stage: "onboarding", created: true });
  }
  async completeProfile(name: string, password: string, skip = false) {
    if (!skip) {
      if (name.trim().length > 80) throw new AuthError("name_invalid", "昵称最多 80 个字符");
      if (password) { const invalid = passwordError(password); if (invalid) throw new AuthError("password_invalid", invalid); }
      if (password) await this.request("/api/experience/profile", "POST", { type: "password", value: password });
      if (name.trim()) await this.request("/api/experience/profile", "POST", { type: "extraProfile", values: { name: name.trim() } });
    }
    await this.submit();
  }
  async resetPassword(password: string) {
    const invalid = passwordError(password); if (invalid) throw new AuthError("password_invalid", invalid);
    await this.request("/api/experience/profile/password", "PUT", { password });
    await this.submit();
  }
  async verifyMfa(code: string) {
    await this.request("/api/experience/verification/totp/verify", "POST", { code });
    await this.submit();
  }
}
