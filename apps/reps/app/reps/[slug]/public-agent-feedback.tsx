import type { PublicAgentProgress, PublicAgentStage, PublicAnswerSource } from '@delegate/web-data';

const labels: Record<PublicAgentStage, [string, string]> = {
  processing: ['正在处理请求', 'Processing your request'],
  knowledge: ['正在查找相关知识', 'Searching authorized knowledge'],
  knowledge_ready: ['已找到相关知识', 'Related knowledge found'],
  knowledge_checked: ['知识检索已结束，正在继续处理', 'Knowledge lookup finished; continuing'],
  search: ['正在检索公开网页', 'Searching public web sources'],
  browser: ['正在访问公开网页', 'Reading a public webpage'],
  mcp: ['正在调用外部服务', 'Calling an external service'],
  compute: ['正在沙盒中处理任务', 'Processing in the sandbox'],
  skills: ['正在加载任务所需能力', 'Loading task capabilities'],
  generating: ['正在整理回答', 'Preparing the answer'],
  verifying: ['正在核对回答与来源', 'Checking the answer against its sources'],
  revising: ['正在修正回答', 'Revising the answer'],
};

export function PublicRunProgress({ progress, now, locale }: { progress?: PublicAgentProgress | undefined; now: number; locale: 'zh' | 'en' }) {
  const zh = locale === 'zh';
  const elapsed = progress ? Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 1000)) : undefined;
  return <p className="representative-run-progress" role="status" aria-live="polite">
    <span>{progress ? labels[progress.stage][zh ? 0 : 1] : zh ? '请求已提交，等待处理' : 'Request submitted; waiting for processing'}</span>
    {elapsed !== undefined ? <span className="representative-run-elapsed" aria-live="off">{zh ? `已等待 ${elapsed} 秒` : `${elapsed}s elapsed`}</span> : null}
  </p>;
}

export type PublicSourceCitation = { title: string; kind?: 'knowledge' | 'memory' | 'authorized'; excerpt?: string };

export function PublicAnswerSources({ sources = [], citations = [], locale }: {
  sources?: PublicAnswerSource[] | undefined; citations?: PublicSourceCitation[] | undefined; locale: 'zh' | 'en';
}) {
  const zh = locale === 'zh';
  if (!sources.length && !citations.length) return null;
  return <div className="representative-answer-sources" aria-label={zh ? '回答来源' : 'Answer sources'}>
    <span>{zh ? '来源' : 'Sources'}</span>
    {citations.map((citation, index) => <span className="representative-source-item" key={`citation-${index}`}>
      {citation.kind === 'knowledge' ? zh ? '知识库' : 'Knowledge'
        : citation.kind === 'memory' ? zh ? '授权记忆' : 'Authorized memory' : zh ? '授权资料' : 'Authorized material'} · {citation.title}
    </span>)}
    {sources.map((source, index) => <span className="representative-source-item" key={`source-${index}`}>
      {source.kind === 'web' ? <a href={source.url} target="_blank" rel="noopener noreferrer">
        <span aria-hidden="true">↗ </span>{source.title}
        <span className="representative-source-kind"> · {source.access === 'page' ? zh ? '网页' : 'Page' : zh ? '网页检索' : 'Web search'}</span>
      </a> : <span>{source.title}<span className="representative-source-kind"> · MCP</span></span>}
    </span>)}
  </div>;
}
