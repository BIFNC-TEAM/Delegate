import type { PiToolObservation } from './types';

export type DateMeaning = {
  id: string;
  basis: 'page_field' | 'fetch_timestamp' | 'request_clock' | 'missing_in_snapshot';
  callId?: string | undefined;
  sourceQuote?: string | undefined;
  supported: boolean;
};

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const chineseDays = '日一二三四五六';
const datePattern = () => /(?<!\d)([12]\d{3})\s*(?:-|\/|年)\s*(\d{1,2})\s*(?:-|\/|月)\s*(\d{1,2})(?:\s*日)?(?!\d)/gu;
const timestampPattern = () => /\b[12]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/gu;

function dates(text: string) {
  return [...text.matchAll(datePattern())].map(match => {
    const value = `${match[1]}-${match[2]!.padStart(2,'0')}-${match[3]!.padStart(2,'0')}`;
    const time = new Date(`${value}T00:00:00Z`);
    const valid = Number.isFinite(time.getTime()) && time.toISOString().slice(0,10) === value;
    return { value, valid, weekday: valid ? time.getUTCDay() : -1, start: match.index!, end: match.index! + match[0].length };
  });
}

export function hasDateAssertions(candidate: string) {
  return dates(candidate.replace(/https?:\/\/[^\s)）>]+/gu, '')).length > 0;
}

/** The host identifies occurrences and retains their surrounding labels.
 * The reviewer cannot reduce a publication claim to just matching digits. */
export function dateAssertions(candidate: string) {
  const masked = candidate.replace(/https?:\/\/[^\s)）>]+/gu, match=>' '.repeat(match.length));
  return dates(masked).map((date,index)=>{
    // Do not mix a neighboring assertion's field label or negation into this
    // occurrence. Keep the same context budget inside the actual clause.
    const left=candidate.slice(0,date.start);
    const start=Math.max(0,...[...left.matchAll(/[。！？!?；;\n]/gu)].map(m=>m.index!+1));
    const right=candidate.slice(date.end);
    const boundary=right.search(/[。！？!?；;\n]/u);
    const end=boundary<0?candidate.length:date.end+boundary;
    return {id:`claim_${date.value}_${index+1}`,date:date.value,
      text:candidate.slice(Math.max(start,date.start-160),Math.min(end,date.end+120)),
      before:candidate.slice(Math.max(start,date.start-160),date.start),
      after:candidate.slice(date.end,Math.min(end,date.end+120))};
  });
}

function pageText(observation: PiToolObservation) {
  try {
    const page = JSON.parse(observation.text);
    // URLs, link directories and fetch timestamps are not source data dates.
    if (typeof page.textSnippet === 'string') return page.textSnippet as string;
  } catch { /* Authorized plain-text observations retain their original text. */ }
  return observation.text;
}

/** Calendar/publication explanations are factual claims even in parentheses.
 * This narrow backstop requires source wording; it never infers a calendar rule. */
function unsupportedDateExplanations(candidate: string, observations: PiToolObservation[]): string[] {
  const normalize = (text:string) => text.normalize('NFKC').replace(/[\s*_`#>]+/gu,'').replace(/^[-–—]+/u,'').toLowerCase();
  // Existing date-context vocabulary, applied to assertions as well as
  // causal explanations. A date value alone cannot license a new event label.
  const contextWord = /(?:交易日|工作日|收盘|公布|发布|更新|披露|延迟|T\s*\+\s*\d|trading|business days?|publish|releas|delay)/giu;
  const terms = (value:string) => [...value.matchAll(contextWord)].map(m=>{
    const word=m[0].toLowerCase().replace(/\s+/gu,'');
    return /公布|发布|披露|publish|releas/u.test(word)?'publication':word;
  });
  const bodies=observations.filter(o=>['completed','succeeded','success','found'].includes(o.status)
    && (!o.observation || o.observation.state==='available')).map(pageText);
  const fields=bodies.flatMap(body=>{
    const parts=body.split(/[，,。！？!?；;\n\t]/u);
    // Tabular headers belong to their own cells, never the adjacent date column.
    let headers:string[]=[];
    for(const line of body.split('\n')) {
      const cells=line.split('\t').map(v=>v.trim());
      if(cells.length<2){headers=[];continue;}
      if(!dates(line).length) {headers=cells;continue;}
      if(headers.length===cells.length) cells.forEach((cell,i)=>parts.push(`${headers[i]} ${cell}`));
    }
    return parts;
  });
  return candidate.split(/[，,。！？!?；;\n]/u).map(clause=>clause.trim()).filter(clause=>{
    const words=terms(clause);
    if (!words.length) return false;
    if (/(?:不能|不要|不应|do not|don't).{0,20}(?:推|改|减|加|移|shift|derive)/iu.test(clause)) return false;
    const explanations=/(?:即|因|所以|因此|通常|实际|实为|应为|前一|上一|后一|下一|[上下前后]个|最近.{0,4}(?:交易日|工作日)|惯例|顺延|推算|前移|后移|意味着|actually|therefore|usually|previous|next|(?:last|latest)\s+(?:business|trading)\s+day|due to|because|convention|shift)/iu.test(clause);
    if(explanations) return !bodies.some(body=>normalize(body).includes(normalize(clause)));
    const directBefore = new RegExp(`(?:${contextWord.source})(?:日期|时间|date|time)?\\s*(?:为|是|[:：]|于|on|at)?\\s*$`, 'iu');
    const directAfter = new RegExp(`^\\s*(?:${contextWord.source})`, 'iu');
    const assertedDates=dates(clause).filter(d=>d.valid && (directBefore.test(clause.slice(0,d.start)) || directAfter.test(clause.slice(d.end)))).map(d=>d.value);
    return assertedDates.some(date=>!fields.some(field=>dates(field).some(d=>d.valid&&d.value===date)
      && words.every(word=>terms(field).includes(word))));
  });
}

function localDay(instant: string, timezone: string): string | undefined {
  if (!dates(instant)[0]?.valid) return undefined;
  const d = new Date(instant);
  if (!Number.isFinite(d.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
    const get=(type:string)=>parts.find(p=>p.type===type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return undefined; }
}

function displayLocalInstant(instant:string,timezone:string) {
  try { return new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(instant)); }
  catch { return undefined; }
}

export function buildSourceDateEvidence(observations: PiToolObservation[], timezone = 'Asia/Shanghai') {
  return observations.filter(o => ['completed','succeeded','success','found'].includes(o.status)
    && (!o.observation || o.observation.state === 'available')).map(o => {
    const text = pageText(o);
    const sourceDates = [...new Set(dates(text).filter(d=>d.valid).map(d=>d.value))];
    const instants = [...text.matchAll(timestampPattern())].map(m=>m[0]).filter(t=>Boolean(localDay(t,'UTC')));
    const observedAt = o.observation?.observedAt ?? o.sources.find(s=>s.observedAt)?.observedAt;
    return {callId:o.callId, sourceDates, sourceInstants:instants,
      // Keep the field/header around the date. A date appearing elsewhere in
      // the page does not establish its meaning in an answer.
      occurrences: dates(text).filter(d=>d.valid).slice(0,32).map(d=>({date:d.value,
        quote:text.slice(Math.max(0,d.start-160),Math.min(text.length,d.end+100))})),
      sourceInstantLocalDates:instants.map(t=>localDay(t,timezone)).filter((v):v is string=>Boolean(v)),
      calendar:sourceDates.slice(0,32).map(date=>({date,weekday:weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]})),
      ...(observedAt ? {observedAt,
        observationTimeLocal: displayLocalInstant(observedAt,timezone),
        observationTimezone:timezone,observationDateUtc:localDay(observedAt,'UTC'),observationDateLocal:localDay(observedAt,timezone)} : {})};
  });
}

/** Deterministic backstop, not a claim that every date/statement was semantically verified. */
export function checkSourceDates(input:{candidate:string;observations:PiToolObservation[];userText:string;currentTime?:string;timezone?:string;calendarOnly?:boolean;dateMeanings?:DateMeaning[]}) {
  const evidence=buildSourceDateEvidence(input.observations,input.timezone);
  if (!evidence.length) return {failures:[] as string[],evidence};
  const sourceDates=new Set(evidence.flatMap(e=>[...e.sourceDates,...e.sourceInstantLocalDates]));
  const userDates=new Set(dates(input.userText).filter(d=>d.valid).map(d=>d.value));
  const observationDates=new Set(evidence.flatMap(e=>[e.observationDateUtc,e.observationDateLocal]).filter(Boolean));
  const today=input.currentTime?localDay(input.currentTime,input.timezone??'Asia/Shanghai'):undefined;
  const text=input.candidate.replace(/https?:\/\/[^\s)）>]+/gu,'').replace(/\*\*|__/gu,'');
  const failures:string[]=[];
  const instants=evidence.flatMap(e=>[...e.sourceInstants,...(e.observedAt?[e.observedAt]:[])])
    .concat([...input.userText.matchAll(timestampPattern())].map(m=>m[0]),input.currentTime?[input.currentTime]:[]);
  const supportedInstant=(timestamp:string)=>{
    const precision=/T\d{2}:\d{2}(?::\d{2}(?:\.(\d+))?)?/u.exec(timestamp)!;
    const unit=precision[1]?10**(3-precision[1].length):precision[0].split(':').length===3?1000:60000;
    return Boolean(localDay(timestamp,'UTC')) && instants.some(value=>Math.floor(Date.parse(value)/unit)===Math.floor(Date.parse(timestamp)/unit));
  };
  const timestampClaims=[...text.matchAll(timestampPattern())];
  for(const claim of timestampClaims)if(!supportedInstant(claim[0]))failures.push(`Timestamp ${claim[0]} does not represent an observed/source instant. Preserve the actual timestamp or a correct timezone conversion; a date-only value supplies no time of day.`);
  if (!input.calendarOnly && dates(text).length) {
    for (const explanation of unsupportedDateExplanations(text,input.observations)) {
      failures.push(`The source does not state this calendar/publication explanation: ${explanation}. Omit it and report the displayed date/value only; do not infer a previous business day, release convention or reporting delay.`);
    }
  }
  for(const d of dates(text)){
    const before=text.slice(Math.max(0,d.start-40),d.start);
    const after=text.slice(d.end,d.end+45);
    const negated=/(?:不是|并非|而非|not)\s*$/iu.test(before) || /^\s*(?:不是|并非|is not)/iu.test(after);
    if(!d.valid){if(!negated)failures.push(`Invalid calendar date ${d.value}; remove or correct the assertion.`);continue;}
    const clause=after.split(/[。；;\n]/u)[0]??'';
    const nextDate=datePattern().exec(clause);
    const weekdaysInClause=clause.slice(0,nextDate?.index??clause.length).matchAll(/(?:星期|礼拜|周)([一二三四五六日天])|\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/giu);
    for(const weekday of weekdaysInClause){
      if (/(?:不是|并非|not|上|下|每|last|next)\s*$/iu.test(after.slice(0,weekday.index))) continue;
      const claimed=weekday[1]?chineseDays.indexOf(weekday[1]==='天'?'日':weekday[1]):weekdays.findIndex(w=>w.toLowerCase()===weekday[2]!.toLowerCase());
      if(claimed!==d.weekday)failures.push(`${d.value} is ${weekdays[d.weekday]}, not the asserted weekday. Calendar arithmetic does not establish a trading/working day.`);
    }
    // Bind the access label to this date, in either word order. A label in a
    // preceding clause/parenthesis cannot license a separate business date.
    const accessLabel='(?:观察|观测|抓取|访问|读取|检索|获取|observed|fetched|accessed|retrieved)';
    const beforeField=before.split(/[，,。！？!?；;\n）)]/u).at(-1) ?? '';
    const observationLabel=new RegExp(`${accessLabel}[^。；;\\n]{0,24}$`,'iu').test(beforeField)
      || new RegExp(`^\\s*(?:日\\s*)?(?:\\d{1,2}:\\d{2}(?::\\d{2})?\\s*)?(?:[（(][^()（）\\n]{1,24}[)）]\\s*)?[（(]?\\s*${accessLabel}`,'iu').test(after);
    const currentLabel=/(?:今天|今日|当前日期|today|current date)[是为：:\s（(]*$/iu.test(before);
    const convertedInstant=timestampClaims.some(t=>t.index!<=d.start && t.index!+t[0].length>=d.end && supportedInstant(t[0]));
    if(!input.calendarOnly && input.dateMeanings === undefined && !negated&&!sourceDates.has(d.value)&&!userDates.has(d.value)&&!convertedInstant&&!(observationLabel&&observationDates.has(d.value))&&!(currentLabel&&d.value===today)){
      failures.push(`The answer introduces ${d.value}, absent from source data dates. Preserve the source's stated date; do not derive a replacement from a publication delay, weekday or assumed platform convention. Explicit date calculations need their own evidence.`);
    }
  }
  if (input.dateMeanings !== undefined) {
    const assertions=dateAssertions(input.candidate);
    const covered = new Set<string>();
    for (const binding of input.dateMeanings) {
      const assertion=assertions.find(a=>a.id===binding.id);
      if(!assertion || covered.has(binding.id)) { failures.push('A date binding must reference one distinct host-provided assertion.'); continue; }
      covered.add(binding.id);
      const claim=assertion.text;
      if (!binding.supported) { failures.push(`Unsupported date meaning in: ${claim}`); continue; }
      const claimDates=[assertion.date];
      const browserSources=input.observations.filter(o=>o.toolName==='browse_in_sandbox');
      // An optional reference is resolvable only when the selected browser
      // evidence is unambiguous. Never replace a supplied invalid reference.
      const observation=input.observations.find(o=>o.callId===binding.callId)
        ?? (!binding.callId && binding.basis==='missing_in_snapshot' && browserSources.length===1 ? browserSources[0] : undefined);
      const reference=evidence.find(e=>e.callId===binding.callId);
      const quote=binding.sourceQuote;
      if (binding.basis==='page_field') {
        if (!observation || !reference || !quote?.trim() || !pageText(observation).includes(quote)) {
          failures.push(`The date assertion has no exact available source excerpt: ${claim}`); continue;
        }
        // A date event must be supported by the cited field, not by an
        // unrelated publication/update elsewhere on the same page.
        const offset=assertion.before.length;
        const prefix=assertion.text.slice(0,offset);
        const fieldStart=Math.max(prefix.lastIndexOf('，'),prefix.lastIndexOf(','))+1;
        const suffix=assertion.text.slice(offset);
        const nextField=suffix.search(/[，,]/u);
        const fieldEnd=nextField<0?assertion.text.length:offset+nextField;
        for(const unsupported of unsupportedDateExplanations(assertion.text.slice(fieldStart,fieldEnd),[{...observation,text:quote}]))
          failures.push(`The cited field does not support this date meaning: ${unsupported}`);
        const excerptDates=dates(quote).filter(d=>d.valid).map(d=>d.value);
        if(claimDates.some(d=>!excerptDates.includes(d) && !reference.sourceInstantLocalDates.includes(d))) failures.push(`The cited field does not contain this date: ${claim}`);
      } else if(binding.basis==='fetch_timestamp') {
        if(!reference?.observedAt || claimDates.some(d=>d!==reference.observationDateUtc && d!==reference.observationDateLocal)) failures.push(`The observation date does not match this receipt: ${claim}`);
      } else if(binding.basis==='request_clock') {
        if(claimDates.some(d=>d!==today && !userDates.has(d))) failures.push(`The request/current time does not support this date: ${claim}`);
      } else {
        // The reviewer judges the scope of a negative statement; the host
        // requires an actual attempt and a grounded requested date, not an
        // invented source record. Failed observations never support values.
        if(!observation || claimDates.some(d=>d!==today && !userDates.has(d) && !sourceDates.has(d))) failures.push(`The reported evidence gap has no matching attempt/request date: ${claim}`);
      }
    }
    for(const assertion of assertions) if(!covered.has(assertion.id)) failures.push(`Date assertion ${assertion.date} has no meaning/evidence binding.`);
  }
  return {failures:[...new Set(failures)],evidence};
}

export const sourceDateMeaningInstructions = 'Return one dateMeanings item for each host-provided dateAssertions id: {id, basis: page_field|fetch_timestamp|request_clock|missing_in_snapshot, callId?: observation callId, sourceQuote?: exact page excerpt including the field label/header, supported: boolean}. text is the unchanged candidate clause containing that occurrence; do not judge bare digits. A value-date is not a publication date; a link headline or user comment is not a confirmed event for the current subject. page_field requires the actual field and its context; fetch_timestamp is only the browser receipt observedAt, never a value seen on the page; request_clock uses the supplied request/current time; missing_in_snapshot describes only the specific captured result/attempt, never global nonexistence. An observation label can occur before or after its date. A known date must not acquire an unsupported release schedule, market status or intraday meaning. Mark unsupported meanings false and identify the specific defect in missing; do not write a replacement answer. Use summary="" and put only specific defects in missing. Output only the listed dateMeanings fields, without copying text. Source quote existence is not by itself proof of the claimed meaning.';

export const sourceDateInstructions = 'SOURCE DATE FIDELITY: Treat every date explanation, parenthesis, weekday, release schedule and platform-convention claim as a factual claim, not harmless commentary. Use the actual source data date. Never subtract a day or infer another effective date from publication delay, T+1, weekends or assumed conventions. Calendar weekdays do not prove trading/working-day status. Separate source data dates from observedAt; only complete timestamps with an explicit timezone can be converted as instants. A date-only value cannot be shifted by timezone. Do not add an unrequested calendar explanation. Return sourceDatesSupported=false and claimsSupported=false if any date explanation is unsupported, even if the quoted value and original date are correct. Otherwise return sourceDatesSupported=true.';
