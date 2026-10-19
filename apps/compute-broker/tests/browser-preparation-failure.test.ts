import {describe,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>{
 const session:any={id:'session',representativeId:'rep',contactId:'contact',conversationId:'old-conversation',generationRunId:null,requestedBy:'OWNER',runtimeClass:'BROWSER',runnerType:'DOCKER',sandboxLeaseId:null,representative:{slug:'fixture'}};
 let row:any={};const client:any={toolExecution:{create:vi.fn(async({data})=>(row={id:'execution',...data})),updateMany:vi.fn(async({where,data})=>{if(where.executionLeaseToken && where.executionLeaseToken!==row.executionLeaseToken)return{count:0};Object.assign(row,data);return{count:1}}),findUniqueOrThrow:vi.fn(async()=>row)},computeSession:{update:vi.fn(async({data})=>Object.assign(session,data))},eventAudit:{create:vi.fn()},$transaction:vi.fn(async fn=>fn(client))};
 return{client,session,row:()=>row,ensure:vi.fn(async()=>{throw new Error('runtime unavailable')}),browse:vi.fn(),bill:vi.fn(async()=>({computeCostCents:0,storageCostCents:0,browserCostCents:0,providerCostCents:0,mcpCostCents:0})),navigate:vi.fn()};
});
vi.mock('../src/prisma',()=>({prisma:mock.client}));
vi.mock('../src/policy',()=>({evaluateExecutionRequest:vi.fn(async(_id,input)=>({input,context:{session:mock.session,profile:{networkMode:'full',filesystemMode:'ephemeral_full'}},decision:{decision:'allow',reason:'fixture'},sessionSubagentId:'browser-agent'}))}));
vi.mock('../src/leases',()=>({ensureComputeSessionLease:mock.ensure}));
vi.mock('../src/billing',()=>({recordExecutionCosts:mock.bill}));
vi.mock('../src/browser-sessions',()=>({recordBrowserNavigation:mock.navigate}));
vi.mock('../src/lifecycle-hooks',()=>({computeLifecycleHooks:{emit:vi.fn()}}));
// Payload formatting is covered by protocol tests; exercise the real preflight,
// execution state transitions and cost inputs here with a stateful fake database.
vi.mock('../src/serializers',async importOriginal=>({...await importOriginal<any>(),serializeSession:(s:any)=>s,serializeExecution:(s:any)=>s}));
vi.mock('@delegate/compute-protocol',async importOriginal=>({...await importOriginal<any>(),executeToolResponseSchema:{parse:(x:any)=>x}}));
describe('browser startup failure finalization',()=>{
 it.each(['AUDIENCE','OWNER'])('closes preparation failures without charging; recovery is anonymous only (%s)',async requestedBy=>{
  vi.clearAllMocks();mock.session.requestedBy=requestedBy;
  process.env.COMPUTE_BROKER_INTERNAL_TOKEN='fixture';
  const {executeTool}=await import('../src/executions');
  const url='https://example.com/original';
  const result=await executeTool('session',{capability:'browser',subagentId:'browser-agent',browserMode:'deterministic',allowMutations:false,url});
  expect(mock.ensure).toHaveBeenCalledWith(expect.objectContaining({recoverMissingBrowserRuntime:requestedBy==='AUDIENCE'}));
  expect(mock.row()).toMatchObject({status:'FAILED',transportOutcome:'confirmed_not_sent',semanticOutcome:'failed',executionLeaseToken:null,requestedCommand:url});
  expect(mock.row().finishedAt).toBeInstanceOf(Date);
  expect(mock.navigate).toHaveBeenCalledWith(expect.objectContaining({requestedUrl:url,status:'failed'}));
  expect(mock.bill).toHaveBeenCalledOnce();expect(mock.bill).toHaveBeenCalledWith(expect.objectContaining({computeCostCents:0,storageCostCents:0,browserCostCents:0,providerCostCents:0}));
  expect(result.outcome).toBe('failed');expect(mock.session.status).toBe('IDLE');
 });
});
