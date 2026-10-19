import {describe,it,expect} from 'vitest';
import {publicSearchHeaders,normalizePublicSearchResult} from '../src/bailian-search';
const endpoint='https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp';
const result=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
const page={title:'Public source',url:'https://example.com/page',snippet:'A retrieved fact.',images:['tracking-image'],hostlogo:'tracking-logo'};

describe('official generic search connector',()=>{
 it('uses only a server-held key and fails when it is missing',()=>{
  expect(publicSearchHeaders(new URL(endpoint),{DELEGATE_BAILIAN_API_KEY:'synthetic-key'})).toEqual({authorization:'Bearer synthetic-key'});
  expect(()=>publicSearchHeaders(new URL(endpoint),{})).toThrow('mcp_search_credentials_missing');
 });
 it.each(['http://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp',endpoint+'?key=x','https://untrusted.example/mcp','https://user:pass@dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp','https://dashscope.aliyuncs.com/other'])('never sends that key to a different endpoint: %s',url=>{
  expect(publicSearchHeaders(new URL(url),{DELEGATE_BAILIAN_API_KEY:'synthetic-key'})).toEqual({});
 });
 it('preserves actual snippets and URLs while excluding image/tracking metadata',()=>{
  const normalized=normalizePublicSearchResult(result({status:0,request_id:'receipt',pages:[page]}));expect(normalized.isError).toBe(false);
  const value=JSON.parse(normalized.content[0]!.text);expect(value.pages).toEqual([{title:page.title,url:page.url,snippet:page.snippet}]);expect(value.requestId).toBe('receipt');expect(value.note).toContain('not full-page reads');expect(JSON.stringify(value)).not.toContain('tracking');
 });
 it.each([null,{}, {status:1,request_id:'r',pages:[page]}, {status:0,pages:[page]}, {status:0,request_id:'r',pages:[null]}, {status:0,request_id:'r',pages:[{...page,url:'file:///secret'}]}, {status:0,request_id:'r',pages:[{...page,url:'https://u:p@example.com'}]}])('does not turn invalid provider output into success: %j',value=>{
  expect(normalizePublicSearchResult(result(value)).isError).toBe(true);
 });
 it('preserves an empty result as a completed search, without claiming absence',()=>{
  const normalized=normalizePublicSearchResult(result({status:0,request_id:'r',pages:[]}));expect(normalized.isError).toBe(false);
  expect(JSON.parse(normalized.content[0]!.text)).toMatchObject({returnedCount:0,pages:[]});expect(normalized.content[0]!.text).toContain('do not establish');
 });
 it('does not disclose provider errors and declares bounded results',()=>{
  expect(normalizePublicSearchResult({isError:true,content:[{type:'text',text:'private error'}]}).content[0]!.text).not.toContain('private error');
  const normalized=normalizePublicSearchResult(result({status:0,request_id:'r',pages:Array.from({length:12},()=>page)}));
  expect(JSON.parse(normalized.content[0]!.text)).toMatchObject({returnedCount:10,totalResults:12,truncated:true});
 });
});
