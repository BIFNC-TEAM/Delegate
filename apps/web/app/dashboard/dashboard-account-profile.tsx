"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OwnerIdentityProfile } from "@delegate/web-data/owner-identity-profile";
import type { Locale } from "@delegate/web-ui";
import { buildAccountCenterHref } from "./settings-section-navigation";

export function DashboardAccountProfile({ locale, available = true, children }: { locale: Locale; available?: boolean; children?: ReactNode }) {
  const zh = locale === 'zh';
  const [profile, setProfile] = useState<OwnerIdentityProfile | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const load = async () => {
    if (!available) return;
    const version = ++requestVersion.current;
    try {
      const response = await fetch('/api/dashboard/account-profile', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json() as OwnerIdentityProfile;
      if (version === requestVersion.current) { setProfile(data); setError(''); }
    } catch { if (version === requestVersion.current) setError(zh ? '暂时无法读取账号信息，请重试。' : 'Account information is unavailable. Please retry.'); }
  };
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [locale, available]);
  const chooseFile = (selected: File | undefined) => {
    if (!selected) return;
    setError(''); setNotice('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) { setError(zh ? '请选择 JPG、PNG 或 WebP 图片。' : 'Choose a JPG, PNG, or WebP image.'); return; }
    if (!selected.size || selected.size > 5 * 1024 * 1024) { setError(zh ? '图片不能为空，且不得超过 5 MB。' : 'Choose a non-empty image up to 5 MB.'); return; }
    setFile(selected);
  };
  const save = async (remove = false) => {
    if (saving || (!remove && !file)) return;
    setSaving(true); setError(''); setNotice(''); ++requestVersion.current;
    try {
      const form = new FormData(); if (file) form.set('avatar', file);
      const response = await fetch('/api/dashboard/account-profile', remove
        ? { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar: '' }) }
        : { method: 'POST', body: form });
      if (!response.ok) {
        if ([400, 413, 415].includes(response.status)) throw new Error(zh ? '图片无效。请选择不超过 5 MB、像素不超过 2000 万的静态 JPG、PNG 或 WebP 图片。' : 'Use a valid non-animated JPG, PNG, or WebP, up to 5 MB and 20 megapixels.');
        throw new Error(zh ? '头像保存未完成，请重试；若网络中断，请先刷新确认保存结果。' : 'Avatar save could not be confirmed. Refresh your profile before retrying.');
      }
      const saved = await response.json() as OwnerIdentityProfile;
      ++requestVersion.current; setProfile(saved); setFile(null);
      setNotice(saved.avatarCleanupPending
        ? (zh ? '头像已保存，旧图片清理暂未完成。' : 'Avatar saved; the old image could not yet be cleaned up.')
        : remove ? (zh ? '头像已移除' : 'Avatar removed') : (zh ? '头像已上传并保存' : 'Avatar uploaded and saved'));
    } catch (e) { setError(e instanceof Error ? e.message : (zh ? '网络请求失败' : 'Network request failed')); }
    finally { setSaving(false); }
  };
  const link = (href: string | undefined, label: string) => {
    const destination = buildAccountCenterHref(href, window.location.origin, locale);
    return destination ? <a className="dashboard-v2-button-secondary" href={destination}>{label}</a> : <span className="settings-action-note">{zh ? '管理入口未配置' : 'Management unavailable'}</span>;
  };
  const accounts = profile?.socialAccounts ?? [];
  const providerName = (account: OwnerIdentityProfile['socialAccounts'][number]) => zh ? account.name['zh-CN'] || account.name.en : account.name.en;
  if (!available) return <>{children}</>;
  return <div className="account-profile-content">
    {error && <p role="alert" className="settings-field-error">{error} <button type="button" onClick={() => { void load(); }}>{zh ? '重试' : 'Retry'}</button></p>}
    {!profile && !error && <p role="status">{zh ? '正在读取账号信息…' : 'Loading account…'}</p>}
    {profile && <>
      <div className="account-profile-avatar-row">
        {preview || profile.avatar ? <img src={preview || profile.avatar!} alt={zh ? (preview ? '待上传头像预览' : '当前头像') : (preview ? 'New avatar preview' : 'Current avatar')} className="account-profile-avatar" referrerPolicy="no-referrer" /> : <span className="account-profile-avatar is-empty" aria-label={zh ? '未设置头像' : 'No avatar'}>D</span>}
        <div className="account-profile-upload">
          <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label={zh ? '选择头像图片' : 'Choose avatar image'} disabled={saving} onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
          <div className="account-profile-upload-actions">
            <button type="button" className="dashboard-v2-button-secondary" disabled={saving} onClick={() => fileInput.current?.click()}>{zh ? '选择本地图片' : 'Choose image'}</button>
            {file && <><button type="button" className="dashboard-v2-button-primary" disabled={saving} onClick={() => { void save(); }}>{saving ? (zh ? '上传中…' : 'Uploading…') : (zh ? '上传并保存' : 'Upload and save')}</button><button type="button" className="dashboard-v2-button-secondary" disabled={saving} onClick={() => setFile(null)}>{zh ? '取消选择' : 'Cancel selection'}</button></>}
            {!file && profile.avatar && <button type="button" className="dashboard-v2-button-secondary" disabled={saving} onClick={() => { void save(true); }}>{zh ? '移除头像' : 'Remove avatar'}</button>}
          </div>
          <p className="settings-action-note">{file ? file.name : (zh ? '支持静态 JPG、PNG、WebP，最大 5 MB；保存为居中裁剪的方形头像。' : 'JPG, PNG, or WebP, up to 5 MB. Saved as a centered square avatar.')}</p>
        </div>
      </div>
      {notice && <p role="status">{notice}</p>}
    </>}
    {children}
    {profile && <>
      <div className="account-profile-method"><div><strong>{zh ? '绑定手机号' : 'Phone'}</strong><p>{profile.phone ?? (zh ? '尚未绑定' : 'Not linked')}</p></div>{link(profile.links?.phone, zh ? (profile.phone ? '更换手机号' : '绑定手机号') : 'Manage phone')}</div>
      <div className="account-profile-method"><div><strong>{zh ? '绑定邮箱' : 'Email'}</strong><p>{profile.email ?? (zh ? '尚未绑定' : 'Not linked')}</p></div>{profile.links?.email ? link(profile.links.email, zh ? (profile.email ? '更换邮箱' : '绑定邮箱') : 'Manage email') : <span className="settings-action-note">{zh ? '邮箱验证服务暂未启用' : 'Email verification is not enabled yet'}</span>}</div>
      <div className="account-profile-method"><div><strong>{zh ? '登录密码' : 'Password'}</strong><p>{profile.hasPassword ? (zh ? '已设置' : 'Set') : (zh ? '尚未设置，可继续使用微信或验证码登录' : 'Not set; social or code sign-in remains available')}</p></div>{link(profile.links?.password, zh ? (profile.hasPassword ? '修改密码' : '设置密码') : 'Manage password')}</div>
      <div className="account-profile-method account-profile-social" role="group" aria-labelledby="account-social-heading">
        <strong id="account-social-heading">{zh ? '三方账号绑定' : 'Third-party accounts'}</strong>
        {accounts.length ? accounts.map((account) => <div className="account-profile-provider" key={account.provider}>
          <p>{providerName(account)} · {account.linked ? (zh ? '已绑定' : 'Linked') : (zh ? '尚未绑定' : 'Not linked')}</p>
          <div className="account-profile-upload-actions">
            {account.actions ? account.linked ? <>{link(account.actions.change, zh ? '更换绑定' : 'Change account')}{link(account.actions.remove, zh ? '解除绑定' : 'Unlink')}</> : link(account.actions.bind, zh ? '绑定账号' : 'Link account') : <span className="settings-action-note">{zh ? '当前仅可查看' : 'Read only'}</span>}
          </div>
        </div>) : <p>{zh ? '暂无可用服务' : 'No providers available'}</p>}
      </div>
    </>}
  </div>;
}
