import { describe, expect, it } from 'vitest';
import { checkSourceAttributions, sourceAttributionUnits, sourceAttributionExcerpt } from '../src/pi/source-attributions';
import type { PiToolObservation } from '../src/pi/types';
const page: PiToolObservation = { callId:'page',toolName:'browse_in_sandbox',status:'completed',text:JSON.stringify({textSnippet:'[heading] "推荐 方案甲"\n[heading] "方案乙"\n[link text] "AirPods 新款"\n[heading] "unfinished'}),sources:[],artifacts:[],observation:{state:'available'} };
const units=sourceAttributionUnits([page]);
describe('source attribution witnesses',()=>{
  it('keeps complete source units and excludes failed or truncated evidence',()=>{
    expect(units.map(u=>u.text)).toEqual(['推荐 方案甲','方案乙','AirPods 新款']);
    expect(sourceAttributionUnits([{...page,observation:{state:'blocked'}}])).toEqual([]);
  });
  it('accepts an attribute in its own heading',()=>{
    expect(checkSourceAttributions('方案甲被标注为推荐。',units,[{subject:'方案甲',attribute:'推荐',unitId:'page:unit_1',present:true}])).toEqual([]);
  });
  it.each(['page:unit_1','page:unit_2','forged'])('rejects a wrong attribution even if a model supplies %s as its evidence',unitId=>{
    expect(checkSourceAttributions('方案乙被标注为推荐。',units,[{subject:'方案乙',attribute:'推荐',unitId,present:true}]).length).toBeGreaterThan(0);
  });
  it('accepts a Chinese label next to a Latin object while keeping Latin name boundaries',()=>{
    expect(checkSourceAttributions('Item A 被标注为推荐。',[{id:'u',callId:'page',kind:'heading',text:'推荐Item A'}],[{subject:'Item A',attribute:'推荐',unitId:'u',present:true}])).toEqual([]);
  });
  it('checks an explicitly absent label within that unit only',()=>{
    expect(checkSourceAttributions('方案乙未标注推荐。',units,[{subject:'方案乙',attribute:'推荐',unitId:'page:unit_2',present:false}])).toEqual([]);
    expect(checkSourceAttributions('方案甲未标注推荐。',units,[{subject:'方案甲',attribute:'推荐',unitId:'page:unit_1',present:false}]).length).toBeGreaterThan(0);
  });
  it('rejects missing witnesses and does not confuse a name prefix with an object',()=>{
    expect(checkSourceAttributions('方案乙被标注为推荐。',units,[]).length).toBeGreaterThan(0);
    expect(checkSourceAttributions('Air 被标注为新款。',units,[{subject:'Air',attribute:'新款',unitId:'page:unit_3',present:true}]).length).toBeGreaterThan(0);
  });
  it('leaves non-attribution answers and older plain-text receipts on existing review',()=>{
    expect(checkSourceAttributions('这里有两个方案。',units,[])).toEqual([]);
    expect(checkSourceAttributions('旧文本未提供结构标记。',[],undefined)).toEqual([]);
  });
  it('checks each member of an implied group status',()=>{
    expect(checkSourceAttributions('这里的推荐方案包括方案甲和方案乙。',units,[
      {subject:'方案甲',attribute:'推荐',unitId:'page:unit_1',present:true},
      {subject:'方案乙',attribute:'推荐',unitId:'page:unit_2',present:true},
    ])).toHaveLength(1);
  });
  it('does not derive ranking from a source label or page order',()=>{
    expect(checkSourceAttributions('方案甲是排名第一的方案。',units,[{subject:'方案甲',attribute:'排名第一',unitId:'page:unit_1',present:true}]).length).toBeGreaterThan(0);
  });
  it('degrades to exact source quotations, never the rejected assignment',()=>{
    const input={candidate:'方案甲和方案乙都被标注为推荐。',observations:[page],evidenceIds:['page'],failureCodes:['source_attribution_fidelity','unsupported_candidate'],language:'zh',attributions:[
      {subject:'方案甲',attribute:'推荐',unitId:'page:unit_1',present:true},
      {subject:'方案乙',attribute:'推荐',unitId:'page:unit_2',present:true},
    ]};
    const result=sourceAttributionExcerpt(input);
    expect(result?.text).toContain('"推荐 方案甲"');expect(result?.text).toContain('"方案乙"');
    expect(result?.text).not.toContain('方案乙都被标注');expect(result?.evidenceIds).toEqual(['page']);
    expect(sourceAttributionExcerpt({...input,failureCodes:[]})).toBeUndefined();
    expect(sourceAttributionExcerpt({...input,failureCodes:['source_date_fidelity','unsupported_candidate']})?.text).toBe(result?.text);
    expect(sourceAttributionExcerpt({...input,evidenceIds:[]})).toBeUndefined();
    expect(sourceAttributionExcerpt({...input,failureCodes:['answer_policy','source_attribution_fidelity']})).toBeUndefined();
    expect(sourceAttributionExcerpt({...input,observations:[page,{...page,toolName:'mcp__write'}]})).toBeUndefined();
    const missingWitness=sourceAttributionExcerpt({...input,attributions:[{...input.attributions[0]!,unitId:'forged'}]});
    expect(missingWitness?.text).toContain('标题原文（有限摘录）');
    expect(missingWitness?.text).not.toContain('方案乙都被标注');
  });
});
