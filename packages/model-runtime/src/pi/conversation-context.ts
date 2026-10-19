import type { PiAgentRunInput } from './types';

/** Bare identifiers/values may fill an earlier clarification; no domain taxonomy. */
export function isReferenceReply(value: string): boolean {
  const text = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+%=-]{0,511}$/u.test(text)
    && (/[\d._:@/+%=-]/u.test(text) || /^[A-Z]{2,20}$/u.test(text));
}

/** Resolve a terse value against the nearest user-authored request, not older topics. */
export function focusedConversationContext(input: Pick<PiAgentRunInput, 'userText' | 'history'>) {
  const priorUserContext=(input.history??[]).map((m,i)=>({index:i+1,text:m.text,taskAnchor:m.taskAnchor===true}));
  return {interpretation:'Interpret the current input semantically: it may supply parameters, change the request, cancel it or start a new task. When it supplies/replaces a name, value or preference, keep the active request outcome and constraints not changed by the latest input. Current corrections replace previous parameter values. Do not broaden a parameter update into an entity profile, another task menu or a new authorization question. An explicit new task/cancellation wins. Prior user context is not a queue of tasks. Never revive an old topic unless the current input requests it.',
    activeRequest:priorUserContext.find(m=>m.taskAnchor)??null,priorUserContext,
    currentInput:{index:0,text:input.userText.trim()}};
}

export function currentRequestContext(input: Pick<PiAgentRunInput, 'userText' | 'history' | 'conversationContextMode'>) {
  const current = input.userText.trim();
  if (input.conversationContextMode === 'focused_v1') {
    return JSON.stringify(focusedConversationContext(input));
  }
  if (!isReferenceReply(current)) return current;
  const anchor = [...(input.history ?? [])].reverse()
    .find(message => message.role === 'user' && message.text.trim() && !isReferenceReply(message.text));
  return anchor ? `${anchor.text.trim()}\n用户补充的标识或参数：${current}` : current;
}

/** Retrieval gets visitor text, not prompt instructions or a guessed intent. */
export function knowledgeRequestContext(input: Pick<PiAgentRunInput, 'userText' | 'history' | 'conversationContextMode'>) {
  if (input.conversationContextMode !== 'focused_v1') return currentRequestContext(input);
  const recent=(input.history??[]).slice(-3);
  const anchor=input.history?.find(m=>m.taskAnchor);
  const context=anchor&&!recent.includes(anchor)?[anchor,...recent]:recent;
  return context.length ? `当前输入：${input.userText.trim()}\n最近对话语境：\n${context.map(m=>m.text).join('\n')}` : input.userText.trim();
}

/** Mere source availability is not evidence that a source identifies this value. */
export function containsReference(text: string, reference: string): boolean {
  const normalized = text.normalize('NFKC').toLowerCase();
  const needle = reference.trim().normalize('NFKC').toLowerCase();
  if (!needle) return false;
  let at = normalized.indexOf(needle);
  while (at !== -1) {
    const before = normalized[at - 1] ?? '';
    const after = normalized[at + needle.length] ?? '';
    if (!/[a-z0-9_]/u.test(before) && !/[a-z0-9_]/u.test(after)) return true;
    at = normalized.indexOf(needle, at + 1);
  }
  return false;
}

/** A language hint, not an override of an explicit translation/language request. */
export function resolveReplyLanguage(input: Pick<PiAgentRunInput, 'userText' | 'history' | 'responseLanguage'>): 'zh' | 'en' {
  const texts = [input.userText, ...(input.history ?? []).filter(m => m.role === 'user').map(m => m.text).reverse()];
  for (const text of texts) {
    if (isReferenceReply(text)) continue;
    if (/\p{Script=Han}/u.test(text)) return 'zh';
    if (/[a-z]/iu.test(text)) return 'en';
  }
  return input.responseLanguage?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Reuse already-authorized turns; never fetch unrelated conversation history. */
export function reviewConversationContext(history: PiAgentRunInput['history']) {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let characters = 0;
  const source = history ?? [];
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const message = source[i]!;
    if (!message.text.trim()) continue;
    if (messages.length === 8 || characters + message.text.length > 16000) break;
    messages.unshift({ role: message.role, text: message.text });
    characters += message.text.length;
  }
  return { messages, truncated: messages.length < source.filter(m => m.text.trim()).length };
}
