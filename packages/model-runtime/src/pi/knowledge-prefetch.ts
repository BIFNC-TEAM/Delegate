import { parseTaskControlCommand } from '@delegate/runtime';
import type { PiAgentRunInput, PiEvidenceRequirements } from './types';

/** Skip only explicit non-question shapes; this is not a semantic/topic router. */
export function shouldPrefetchKnowledge(input: PiAgentRunInput, requirements: PiEvidenceRequirements): boolean {
  if (input.knowledgePrefetch !== 'ordinary_questions_v1' || input.executionProtocol === 'legacy_v1'
    || input.checkpoint || input.approvedToolResult || !input.capabilities?.knowledge
    || input.attachments?.length || requirements.sandbox || requirements.browser || requirements.artifact) return false;
  const text = input.userText.trim();
  if (parseTaskControlCommand(text)) return false;
  if (/^(?:你好|您好|嗨|早上好|晚上好|谢谢(?:你|您)?|再见|hello|hi|hey|thanks|thank you|bye)[！!。.\s]*$/iu.test(text)) return false;
  // Credential values are never ordinary Q&A retrieval targets. This narrow
  // exclusion does not reject explanatory questions about credential concepts.
  if (/(?:给我|提供|显示|列出|导出|泄露|show|give|reveal|export).{0,50}(?:密码|密钥|口令|访问令牌|password|secret key|api key|access token)/iu.test(text)) return false;
  // The whole request must be a text transformation. Additional actions outside
  // the quoted operand do not match and must not silently skip retrieval.
  const quoted = '(?:“[^”]+”|「[^」]+」|"[^"]+")';
  const prefix = '(?:(?:请(?:帮我)?|帮我)\\s*)?';
  const suffix = '(?:[，,]\\s*只(?:给|要|输出)(?:译文|结果|改写结果))?[。.!！]?';
  const transform = '(?:翻译成|译成)\\s*(?:中文|汉语|英文|英语|日语|法语|德语)|(?:改写|润色)(?:一下|得简洁些|得更简洁|得自然些)?';
  if (/^(?:(?:请(?:帮我)?|帮我)\s*)?(?:(?:翻译成|译成)\s*(?:中文|汉语|英文|英语|日语|法语|德语)|(?:翻译|改写|润色)(?:(?:以下|这段)(?:文本|文字|内容|句子))?)\s*[：:]\s*\S[\s\S]*$/u.test(text)
    || new RegExp(`^${prefix}(?:把|将)?\\s*${quoted}\\s*(?:${transform})${suffix}$`, 'u').test(text)
    || new RegExp(`^${prefix}(?:翻译|改写|润色)\\s*${quoted}${suffix}$`, 'u').test(text)
    || new RegExp(`^(?:please\\s+)?(?:translate\\s+${quoted}\\s+(?:into|to)\\s+[a-z]+|(?:rewrite|rephrase|polish)\\s+${quoted})[.!]?$`, 'iu').test(text)) return false;
  return true;
}
