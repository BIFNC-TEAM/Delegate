import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),update:vi.fn()}));
vi.mock('@delegate/web-data/owner-identity-profile',()=>({getOwnerIdentityProfile:mocks.get,updateOwnerAvatar:mocks.update,IdentityProfileError:class extends Error{constructor(readonly status:number,message:string){super(message)}}}));
import { handleOwnerProfile } from '../src/owner-profile';
const token='only-a-test-token-with-at-least-32-bytes';
const principal={ownerId:'owner',issuer:'https://login.example.com/oidc',subject:'subject'};
async function invoke(body:unknown,authorization=`Bearer ${token}`){
 const request=Object.assign(Readable.from([JSON.stringify(body)]),{method:'POST',headers:{authorization}});
 const response={writeHead:vi.fn(),end:vi.fn()};
 await handleOwnerProfile(request as IncomingMessage,response as unknown as ServerResponse);return response;
}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('OWNER_PROFILE_INTERNAL_TOKEN',token);mocks.get.mockResolvedValue({hasPassword:false,wechatLinked:false});});
afterEach(()=>vi.unstubAllEnvs());
describe('narrow worker account profile endpoint',()=>{
 it('rejects missing / incorrect service credentials without calling Logto',async()=>{
  expect((await invoke({action:'get',principal},'Bearer wrong')).writeHead.mock.calls[0]?.[0]).toBe(401);expect(mocks.get).not.toHaveBeenCalled();
  vi.stubEnv('OWNER_PROFILE_INTERNAL_TOKEN','');expect((await invoke({action:'get',principal})).writeHead.mock.calls[0]?.[0]).toBe(503);
 });
 it('passes the exact principal to the independently authorized identity reader',async()=>{expect((await invoke({action:'get',principal})).writeHead.mock.calls[0]?.[0]).toBe(200);expect(mocks.get).toHaveBeenCalledWith(principal);});
 it.each([{action:'password',principal,password:'new'}, {action:'avatar',principal:{...principal,admin:true},avatar:''}, {action:'get',principal,allUsers:true}])('rejects expansion beyond the profile contract',async(body)=>{expect((await invoke(body)).writeHead.mock.calls[0]?.[0]).toBe(400);expect(mocks.get).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();});
 it('bounds request size',async()=>{expect((await invoke({action:'avatar',principal,avatar:'x'.repeat(9000)})).writeHead.mock.calls[0]?.[0]).toBe(413);});
});
