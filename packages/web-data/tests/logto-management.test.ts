import { describe, expect, it, vi } from "vitest";

import {
  createLogtoManagementClient,
  readLogtoManagementConfig,
} from "../src/logto-management";

describe("Logto Management API client", () => {
  it("is disabled without credentials and rejects partial configuration", () => {
    expect(readLogtoManagementConfig({})).toBeNull();
    expect(() => readLogtoManagementConfig({
      LOGTO_MANAGEMENT_APP_ID: "app-id",
    })).toThrow("must be configured together");
  });

  it("uses OSS defaults and bounded reconciliation settings", () => {
    expect(readLogtoManagementConfig({
      LOGTO_ENDPOINT: "https://auth.example.com",
      LOGTO_MANAGEMENT_APP_ID: "app-id",
      LOGTO_MANAGEMENT_APP_SECRET: "app-secret",
    })).toMatchObject({
      endpoint: "https://auth.example.com",
      resource: "https://default.logto.app/api",
      pageSize: 100,
      maxPages: 100,
    });
  });

  it("accepts the previous local M2M variable names without copying secrets", () => {
    expect(readLogtoManagementConfig({
      LOGTO_ENDPOINT: "https://auth.example.com",
      LOGTO_M2M_APP_ID: "legacy-app-id",
      LOGTO_M2M_APP_SECRET: "legacy-app-secret",
    })).toMatchObject({
      clientId: "legacy-app-id",
      clientSecret: "legacy-app-secret",
    });
  });

  it("fetches one client-credentials token and paginates users", async () => {
    const requests: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/oidc/token") {
        return Response.json({
          access_token: "management-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "all",
        });
      }
      const page = Number(parsed.searchParams.get("page"));
      return Response.json(
        page === 1
          ? [
              { id: "user-1", isSuspended: false, updatedAt: 1 },
              { id: "user-2", isSuspended: true, updatedAt: 2 },
            ]
          : [],
      );
    });
    const client = createLogtoManagementClient({
      endpoint: "https://auth.example.com",
      clientId: "app-id",
      clientSecret: "app-secret",
      resource: "https://default.logto.app/api",
      requestTimeoutMs: 15_000,
      pageSize: 2,
      maxPages: 5,
    }, fetchImpl);

    await expect(client.listAllUsers()).resolves.toEqual([
      { id: "user-1", isSuspended: false, updatedAt: 1 },
      { id: "user-2", isSuspended: true, updatedAt: 2 },
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization:
        `Basic ${Buffer.from("app-id:app-secret").toString("base64")}`,
    });
    expect(String(requests[0]?.init?.body)).toContain(
      "grant_type=client_credentials",
    );
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: "Bearer management-token",
    });
  });

  it("fails closed when the page cap is reached without a short final page", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(url).pathname === "/oidc/token"
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json([{ id: "user-1", isSuspended: false }]),
    );
    const client = createLogtoManagementClient({
      endpoint: "https://auth.example.com",
      clientId: "app-id",
      clientSecret: "app-secret",
      resource: "https://default.logto.app/api",
      requestTimeoutMs: 15_000,
      pageSize: 1,
      maxPages: 1,
    }, fetchImpl);

    await expect(client.listAllUsers()).rejects.toThrow("MAX_PAGES");
  });
});

describe('current-user profile management contract', () => {
  const config = { endpoint: 'https://auth.example.com', clientId: 'app', clientSecret: 'secret', resource: 'https://default.logto.app/api', requestTimeoutMs: 15000, pageSize: 100, maxPages: 100 };
  it('writes only avatar for the explicitly selected subject and follows no redirects', async () => {
    const request = vi.fn(async (url: string) => url.endsWith('/oidc/token') ? Response.json({ access_token: 'token', expires_in: 3600 }) : Response.json({ id: 'subject' }));
    await createLogtoManagementClient(config, request).updateUserAvatar('subject', 'https://example.com/avatar.png');
    expect(request).toHaveBeenLastCalledWith('https://auth.example.com/api/users/subject', expect.objectContaining({ method: 'PATCH', redirect: 'error', body: JSON.stringify({ avatar: 'https://example.com/avatar.png' }) }));
  });
  it.each([{ id: 'another', hasPassword: true, isSuspended: false }, { id: 'subject', isSuspended: false }, { id: 'subject', hasPassword: false }])('fails closed on malformed profile responses', async (user) => {
    const request = vi.fn(async (url: string) => url.endsWith('/oidc/token') ? Response.json({ access_token: 'token', expires_in: 3600 }) : Response.json(user));
    await expect(createLogtoManagementClient(config, request).getUserProfile('subject')).rejects.toThrow('Invalid Logto account profile');
  });
});

describe('verified email binding capability', () => {
  const config = {endpoint:'https://auth.example.com',clientId:'app',clientSecret:'secret',resource:'https://default.logto.app/api',requestTimeoutMs:15000,pageSize:100,maxPages:100};
  it.each([[true,'Edit',true],[false,'Edit',false],[true,'ReadOnly',false]])('requires enabled email login (%s) and editable account email (%s)',async(enabled,control,expected)=>{
    const request=vi.fn(async(url:string,init?:RequestInit)=>Response.json(url.endsWith('sign-in-exp')?{signIn:{methods:enabled?[{identifier:'email',password:true}]:[{identifier:'phone',password:true}]}}:{enabled:true,fields:{email:control}}));
    await expect(createLogtoManagementClient(config,request).getEmailBindingAvailable()).resolves.toBe(expected);
    expect(request.mock.calls.every(([,init])=>!init?.headers)).toBe(true);
  });
  it('rejects malformed provider status instead of claiming email binding is ready',async()=>{
    await expect(createLogtoManagementClient(config,async()=>Response.json({})).getEmailBindingAvailable()).rejects.toThrow('Invalid Logto account settings');
  });
});


describe('third-party account capabilities', () => {
  const config={endpoint:'https://auth.example.com',clientId:'app',clientSecret:'secret',resource:'https://default.logto.app/api',requestTimeoutMs:15000,pageSize:100,maxPages:100};
  const connectors=[
    {id:'wechat-native',target:'wechat',platform:'Native',name:{en:'WeChat'}},
    {id:'wechat-universal',target:'wechat',platform:null,name:{en:'WeChat'}},
    {id:'wechat-web',target:'wechat',platform:'Web',name:{en:'WeChat','zh-CN':'微信'},privateConfig:'must-not-return'},
    {id:'github-web',target:'github',platform:'Web',name:{en:'GitHub'}},
  ];
  it.each(['Edit','ReadOnly'])('lists available providers, preferring Web and respecting %s controls',async(control)=>{
    const request=vi.fn(async(url:string)=>Response.json(url.endsWith('sign-in-exp')?{signIn:{methods:[]},socialConnectors:connectors}:{enabled:true,fields:{social:control}}));
    const result=await createLogtoManagementClient(config,request).getAccountBindingCapabilities();
    expect(result.socialConnectors.map(c=>c.id)).toEqual(['wechat-web','github-web']);
    expect(result.socialConnectors.every(c=>c.editable===(control==='Edit'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('must-not-return');
  });
  it.each([{enabled:false,fields:{social:'Edit'}},{enabled:true,fields:{social:'Off'}}])('hides disabled account providers',async(center)=>{
    const request=vi.fn(async(url:string)=>Response.json(url.endsWith('sign-in-exp')?{signIn:{methods:[]},socialConnectors:connectors}:center));
    expect((await createLogtoManagementClient(config,request).getAccountBindingCapabilities()).socialConnectors).toEqual([]);
  });
  it.each([{},[{id:'../bad',target:'wechat',name:{en:'WeChat'}}],[{id:'valid',target:'wechat',name:{}}]])('rejects malformed connector configuration',async(socialConnectors)=>{
    const request=vi.fn(async(url:string)=>Response.json(url.endsWith('sign-in-exp')?{signIn:{methods:[]},socialConnectors}:{enabled:true,fields:{social:'Edit'}}));
    await expect(createLogtoManagementClient(config,request).getAccountBindingCapabilities()).rejects.toThrow('Invalid Logto social');
  });
  it('reports unavailable provider settings without inventing binding status',async()=>{
    await expect(createLogtoManagementClient(config,async()=>new Response('',{status:503})).getAccountBindingCapabilities()).rejects.toThrow('503');
  });
});
