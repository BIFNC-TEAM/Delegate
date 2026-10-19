import {describe,it,expect} from 'vitest';
import {isKnowledgeRetrievalServiceConfigured} from '../src/openviking';

describe('knowledge tool configuration availability',()=>{
 it.each([
  [{},false],
  [{OPENVIKING_ENABLED:'false',OPENVIKING_MODEL_CREDENTIALS_CONFIGURED:'true'},false],
  [{OPENVIKING_ENABLED:'true'},false],
  [{OPENVIKING_ENABLED:'true',OPENVIKING_MODEL_CREDENTIALS_CONFIGURED:'true'},true],
  [{OPENVIKING_ENABLED:'true',OPENVIKING_PROVIDER:'openai',OPENVIKING_MODEL_API_KEY:'SYNTHETIC_TEST_ONLY'},true],
  [{OPENVIKING_ENABLED:'true',OPENVIKING_PROVIDER:'volcengine',ARK_API_KEY:'SYNTHETIC_TEST_ONLY'},true],
  [{OPENVIKING_ENABLED:'true',OPENVIKING_MODEL_CREDENTIALS_CONFIGURED:'true',OPENVIKING_BASE_URL:'not-a-url'},false],
 ] as const)('maps config %j to availability %s without querying data', (env,expected)=>{
  expect(isKnowledgeRetrievalServiceConfigured(env)).toBe(expected);
 });
});
