import type { PiAgentRunInput, PiEvidenceRequirements } from './types';

type SimpleTextTask = { kind: 'greeting'; introductions: string[] } | { kind: 'translation'; target: 'en' | 'zh'; source: string };

/** A deliberately small host allowlist, not a general-purpose intent router. */
export function selectSimpleTextTask(input: PiAgentRunInput, requirements: PiEvidenceRequirements): SimpleTextTask | undefined {
  if (input.reviewMode !== 'simple_text_v1' || input.executionProtocol === 'legacy_v1'
    || input.history?.length || input.attachments?.length || input.checkpoint || input.approvedToolResult || input.attachmentEvidenceRecovery
    || requirements.evidence || requirements.browser || requirements.sandbox || requirements.artifact || requirements.outputFiles?.length) return;
  const text = input.userText.trim();
  if (/^(?:你好|您好|嗨|hello|hi|hey)[！!。.\s]*$/iu.test(text)) {
    const { name, ownerName } = input.representative;
    return { kind: 'greeting', introductions: ownerName ? [
      `我是${name}，由${ownerName}授权的数字代表。`,
      `I'm ${name}, a digital representative authorized by ${ownerName}.`,
    ] : [] };
  }
  const policy = input.representative.agentBehavior;
  if (policy?.answerScope !== 'open_public' || policy.knowledgePolicy !== 'owner_facts') return;

  // The entire request must be a quoted operand plus an explicit target language.
  // Commands inside the operand are text; trailing actions do not match.
  const match = text.match(/^(?:(?:请(?:帮我)?|帮我)\s*)?(?:把|将)?\s*(?:“([^”\n]+)”|"([^"\n]+)"|「([^」\n]+)」)\s*(?:翻译成|译成)\s*(英文|英语|中文|汉语)(?:[，,]\s*只(?:给|要|输出)(?:译文|翻译结果))?[。.!！]?$/u)
    ?? text.match(/^(?:please\s+)?translate\s+(?:“([^”\n]+)”|"([^"\n]+)"|「([^」\n]+)」)\s+(?:into|to)\s+(English|Chinese)[.!]?$/iu);
  if (!match) return;
  const source = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  if (!source || source.length > 1000 || /https?:\/\/|```|[<>]/iu.test(source)) return;
  const target = /^(?:英文|英语|English)$/iu.test(match[4] ?? '') ? 'en' : 'zh';
  if (target === 'en' ? !/\p{Script=Han}/u.test(source) : /\p{Script=Han}/u.test(source) || !/[a-z]/iu.test(source)) return;
  return { kind: 'translation', target, source };
}

/** Syntax/shape gate only; this does not certify semantic translation fidelity. */
export function matchesSimpleTextCandidate(task: SimpleTextTask, candidate: string): boolean {
  const text = candidate.trim();
  if (!text || /https?:\/\/|```|[<>]|\]\s*\(/iu.test(text)) return false;
  if (task.kind === 'greeting') {
    if (text.length > 320) return false;
    const greeting = text.match(/^(?:你好|您好|嗨|hello|hi|hey)[！!，,。.\s]*([\s\S]*)$/iu);
    let rest = greeting ? greeting[1]!.trim() : text;
    const introduction = task.introductions.find(value => rest.startsWith(value));
    if (introduction) rest = rest.slice(introduction.length).trim();
    else if (!greeting) return false;
    return !rest || /^(?:请问)?(?:有什么(?:我)?可以帮(?:助)?[你您](?:的)?(?:吗)?|有什么[^。！？?!]{0,40}(?:问题|需要帮助的地方)(?:我可以帮[你您](?:解答|处理))?(?:吗|呢)?|我(?:能|可以)(?:帮[你您](?:做些什么|做什么)|为[你您]做些什么))[？?！!。.\s]*$/u.test(rest)
      || /^how can i (?:help|assist)(?: you)?(?: with [^.!?]{1,64})?(?: today)?[?!.\s]*$/iu.test(rest);
  }
  if (text.includes('\n') || text.length > Math.max(160, task.source.length * 8)) return false;
  return task.target === 'en' ? !/\p{Script=Han}/u.test(text) && /[a-z]/iu.test(text) : /\p{Script=Han}/u.test(text);
}
