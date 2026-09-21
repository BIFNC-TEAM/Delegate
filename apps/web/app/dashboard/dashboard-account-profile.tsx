"use client";
import { useEffect, useRef, useState } from "react";
import type { OwnerIdentityProfile } from "@delegate/web-data/owner-identity-profile";
import type { Locale } from "@delegate/web-ui";

export function DashboardAccountProfile({ locale }: { locale: Locale }) {
  const zh = locale === 'zh';
  const [profile, setProfile] = useState<OwnerIdentityProfile | null>(null);
  const [avatar, setAvatar] = useState('');
  const avatarDirty = useRef(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const load = async () => {
    try {
      const response = await fetch('/api/dashboard/account-profile', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json() as OwnerIdentityProfile;
      setProfile(data); if (!avatarDirty.current) setAvatar(data.avatar ?? ''); setError('');
    } catch { setError(zh ? '暂时无法读取账号信息，请重试。' : 'Account information is unavailable. Please retry.'); }
  };
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [locale]);
  const save = async () => {
    setSaving(true); setError(''); setNotice('');
    try {
      const value = avatar.trim();
      if (value && !/^https:\/\//i.test(value)) throw new Error(zh ? '请填写 HTTPS 头像地址，或留空移除头像。' : 'Use an HTTPS avatar URL, or leave blank to remove.');
      const response = await fetch('/api/dashboard/account-profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar: value }) });
      if (!response.ok) throw new Error(zh ? '头像保存失败，请稍后重试。' : 'Avatar could not be saved. Please retry.');
      const saved = await response.json() as OwnerIdentityProfile;
      setProfile(saved); setAvatar(saved.avatar ?? ''); avatarDirty.current = false;
      setNotice(zh ? '头像已保存' : 'Avatar saved');
    } catch (e) { setError(e instanceof Error ? e.message : (zh ? '网络请求失败' : 'Network request failed')); }
    finally { setSaving(false); }
  };
  const link = (href: string | undefined, label: string) => href ? <a className="dashboard-v2-button-secondary" href={href} target="_blank" rel="noreferrer">{label} ↗</a> : <span className="settings-action-note">{zh ? '管理入口未配置' : 'Management unavailable'}</span>;
  return <section className="dashboard-v2-panel settings-card account-profile-panel" aria-labelledby="account-profile-title">
    <header><p className="dashboard-v2-eyebrow">ACCOUNT PROFILE</p><h2 id="account-profile-title">{zh ? '头像与登录方式' : 'Avatar and sign-in methods'}</h2><p className="settings-card-description">{zh ? '管理已绑定的身份。修改密码、手机号或微信关联时，会先验证你的身份。' : 'Manage linked identities. Sensitive changes require identity verification.'}</p></header>
    {error && <p role="alert" className="settings-field-error">{error} <button type="button" onClick={() => { void load(); }}>{zh ? '重试' : 'Retry'}</button></p>}
    {!profile && !error && <p role="status">{zh ? '正在读取账号信息…' : 'Loading account…'}</p>}
    {profile && <>
      <div className="account-profile-avatar-row">
        {profile.avatar ? <img src={profile.avatar} alt={zh ? '当前头像' : 'Current avatar'} className="account-profile-avatar" referrerPolicy="no-referrer" /> : <span className="account-profile-avatar is-empty" aria-label={zh ? '未设置头像' : 'No avatar'}>D</span>}
        <label className="settings-field"><span>{zh ? '头像地址' : 'Avatar URL'}</span><input type="url" value={avatar} maxLength={2048} onChange={(event) => { avatarDirty.current = true; setAvatar(event.target.value); }} placeholder="https://…" /><small>{zh ? '填写 HTTPS 图片地址；留空可移除头像。' : 'Enter an HTTPS image URL; leave blank to remove.'}</small></label>
        <button type="button" className="dashboard-v2-button-secondary" disabled={saving || avatar === (profile.avatar ?? '')} onClick={() => { void save(); }}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存头像' : 'Save avatar')}</button>
      </div>
      {notice && <p role="status">{notice}</p>}
      <div className="account-profile-method"><div><strong>{zh ? '绑定手机号' : 'Phone'}</strong><p>{profile.phone ?? (zh ? '尚未绑定' : 'Not linked')}</p></div>{link(profile.links?.phone, zh ? (profile.phone ? '更换手机号' : '绑定手机号') : 'Manage phone')}</div>
      <div className="account-profile-method"><div><strong>{zh ? '登录密码' : 'Password'}</strong><p>{profile.hasPassword ? (zh ? '已设置' : 'Set') : (zh ? '尚未设置，可继续使用微信或验证码登录' : 'Not set; social or code sign-in remains available')}</p></div>{link(profile.links?.password, zh ? (profile.hasPassword ? '修改密码' : '设置密码') : 'Manage password')}</div>
      <div className="account-profile-method"><div><strong>{zh ? '微信账号' : 'WeChat'}</strong><p>{profile.wechatLinked ? (zh ? '已绑定' : 'Linked') : (zh ? '尚未绑定' : 'Not linked')}</p></div>{link(profile.links?.social, zh ? '管理第三方账号' : 'Manage linked accounts')}</div>
      {profile.email && <div className="account-profile-method"><div><strong>{zh ? '登录邮箱' : 'Email'}</strong><p>{profile.email}</p></div></div>}
    </>}
  </section>;
}
