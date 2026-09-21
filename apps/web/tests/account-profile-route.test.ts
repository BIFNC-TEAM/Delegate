import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),get:vi.fn(),update:vi.fn()}));
vi.mock('../app/api/dashboard/auth',()=>({requireDashboardApiOwnerSession:mocks.session,dashboardAuthErrorResponse:()=>null}));
vi.mock('@delegate/web-data/owner-identity-profile',()=>({getOwnerIdentityProfile:mocks.get,updateOwnerAvatar:mocks.update,IdentityProfileError:class extends Error{constructor(readonly status:number,message:string){super(message)}}}));
vi.mock('../app/api/dashboard/account-profile/client',()=>({requestOwnerProfile:(principal:unknown,action:string,avatar:unknown)=>action==='get'?mocks.get(principal):mocks.update(principal,avatar)}));
import { GET, PATCH, POST } from '../app/api/dashboard/account-profile/route';
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({ownerId:'owner',issuer:'https://login.test/oidc',subject:'subject'});mocks.get.mockResolvedValue({hasPassword:false});mocks.update.mockResolvedValue({avatar:''});});
describe('private account profile API',()=>{
 it('requires an authenticated complete principal',async()=>{mocks.session.mockResolvedValue(null);expect((await GET()).status).toBe(401);expect(mocks.get).not.toHaveBeenCalled();});
 it('returns private no-store data scoped to the session',async()=>{const response=await GET();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');expect(mocks.get).toHaveBeenCalledWith({ownerId:'owner',issuer:'https://login.test/oidc',subject:'subject'});});
 it('rejects cross-origin writes and caller-provided identity fields',async()=>{
  expect((await PATCH(new Request('https://dashboard.test/api/dashboard/account-profile',{method:'PATCH',headers:{origin:'https://evil.test'},body:JSON.stringify({avatar:''})}))).status).toBe(403);
  expect((await PATCH(new Request('https://dashboard.test/api/dashboard/account-profile',{method:'PATCH',headers:{origin:'https://dashboard.test'},body:JSON.stringify({avatar:'',subject:'another'})}))).status).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();
 });
 it('does not convert upstream failures into empty successful profile',async()=>{mocks.get.mockRejectedValue(new Error('network'));expect((await GET()).status).toBe(503);});
});

describe('multipart avatar upload',()=>{
 function uploadRequest(form:FormData,origin='https://dashboard.test'){return new Request('https://dashboard.test/api/dashboard/account-profile',{method:'POST',headers:{origin},body:form});}
 function fileForm(){const form=new FormData();form.set('avatar',new File([new Uint8Array([137,80,78,71])],'avatar.png',{type:'image/png'}));return form;}
 it('passes only file bytes and the session principal to the worker',async()=>{
  const response=await POST(uploadRequest(fileForm()));expect(response.status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith({ownerId:'owner',issuer:'https://login.test/oidc',subject:'subject'},{base64:Buffer.from([137,80,78,71]).toString('base64')});
 });
 it('rejects unauthenticated and cross-origin uploads before reading storage',async()=>{
  expect((await POST(uploadRequest(fileForm(),'https://evil.test'))).status).toBe(403);
  mocks.session.mockResolvedValue(null);expect((await POST(uploadRequest(fileForm()))).status).toBe(401);expect(mocks.update).not.toHaveBeenCalled();
 });
 it('rejects empty, multiple and oversized files',async()=>{
  expect((await POST(uploadRequest(new FormData()))).status).toBe(400);
  const extra=fileForm();extra.append('ownerId','someone-else');expect((await POST(uploadRequest(extra))).status).toBe(400);
  const huge=new FormData();huge.set('avatar',new File([new Uint8Array(5*1024*1024+1)],'huge.jpg',{type:'image/jpeg'}));expect((await POST(uploadRequest(huge))).status).toBe(413);expect(mocks.update).not.toHaveBeenCalled();
 });
 it('requires multipart rather than trusting a supplied remote URL',async()=>{
  expect((await POST(new Request('https://dashboard.test/api/dashboard/account-profile',{method:'POST',headers:{origin:'https://dashboard.test','content-type':'application/json'},body:JSON.stringify({avatar:'https://evil.test'})}))).status).toBe(415);
 });
});
