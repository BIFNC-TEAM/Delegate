// Offline rescoring of immutable evaluation outputs. No model or tool executions.
import { readFile, writeFile } from 'node:fs/promises';
import { checkV2EvaluationCase, v2ClarificationEvaluationCases, v2CoreEvaluationCases } from '../../packages/model-runtime/src/v2/evaluation-cases';
import { fingerprint } from '../../packages/model-runtime/src/v2/guards';
const reports = [
 'evaluation-2026-10-19T06-38-54-490Z-20747f67-3b49-4b7f-b9f8-429c959184e8.json',
 'evaluation-2026-10-19T06-38-54-491Z-77c84004-7258-4933-982f-e2d84934d22a.json',
 'evaluation-2026-10-19T06-38-54-492Z-8cbd64e6-8853-4fc9-8e82-ae2956e24453.json',
];
const scored=[];
for (const report of reports) {
 const d=JSON.parse(await readFile('reports/agent-v2/'+report,'utf8'));
 for (const row of d.rows) {
  const test=row.resumedFrom ? {id:row.id,question:'上海',rag:false,web:true,fact:'20'} : v2ClarificationEvaluationCases.find(c=>c.id===row.id)!;
  // Resume reports predate explicit toolNames; the original webPolicy check is
  // retained for those rows instead of inventing a trace to re-score them.
  if (!row.resumedFrom && row.question && row.question !== test.question) throw new Error(`Question changed for ${row.id}; refuse to re-score a different case.`);
  const checks=row.resumedFrom ? row.checks : checkV2EvaluationCase(test,row,row.toolNames);
  scored.push({report,id:row.id,repeat:row.repeat,resumedFrom:row.resumedFrom,status:row.status,originalPassed:row.fixtureChecksPass,rescoredPassed:Object.values(checks).every(Boolean),checks});
 }
}
const base=JSON.parse(await readFile('reports/agent-v2/evaluation-2026-10-19T06-14-55-073Z.json','utf8'));
const baseline=base.rows.filter((r:any)=>r.id!=='clarification-resume').map((r:any)=>({id:r.id,repeat:r.repeat,passed:Object.values(checkV2EvaluationCase(v2CoreEvaluationCases.find(c=>c.id===r.id)!,r,r.toolNames)).every(Boolean)}));
const changes=scored.filter(r=>r.originalPassed!==r.rescoredPassed);
const summary={mode:'rescoring-existing-real-model-results-no-new-generation',reports,scoringSha256:fingerprint(await readFile('packages/model-runtime/src/v2/evaluation-cases.ts','utf8')),
 baseline:{report:'evaluation-2026-10-19T06-14-55-073Z.json',rows:baseline},
 originalPassed:scored.filter(r=>r.originalPassed).length,rescoredPassed:scored.filter(r=>r.rescoredPassed).length,total:scored.length,
 explanation:'One English response said "no supporting documents"; original scorer only recognized "no ... record". Original output files and failed check are unchanged. The corrected scorer has a regression test for that exact valid limitation.',changes,rows:scored};
await writeFile('reports/agent-v2/clarification-fix-summary.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({baselinePassed:baseline.filter((r:any)=>r.passed).length,baselineTotal:baseline.length,originalPassed:summary.originalPassed,rescoredPassed:summary.rescoredPassed,total:summary.total,changes:changes.map(c=>({report:c.report,id:c.id}))},null,2));
