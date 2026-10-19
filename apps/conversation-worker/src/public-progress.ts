import type { PiRuntimeEvent } from '@delegate/model-runtime';
import type { PublicAgentStage } from '@delegate/web-data';

/** Only fixed stages leave the worker; no tool arguments, drafts or reasoning. */
export function createPublicProgress(persist: (frame: { sequence: number; stage: PublicAgentStage }) => Promise<unknown>) {
  let sequence = 0;
  let stage: PublicAgentStage | undefined;
  const activeTools = new Map<string, PublicAgentStage>();
  const publish = async (next: PublicAgentStage) => {
    if (next === stage) return;
    stage = next;
    // Presentation failure must not restart the business operation.
    await persist({ sequence: ++sequence, stage }).catch(() => undefined);
  };
  return { async onEvent(event: PiRuntimeEvent) {
    if (event.type === 'request.accepted') return publish('processing');
    if (event.type === 'response.review_started') return publish('verifying');
    if (event.type === 'response.review_rejected') return publish('revising');
    if (event.type === 'model.started') return publish('generating');
    if (event.type === 'tool.started') {
      const name = event.toolName ?? '';
      const next: PublicAgentStage = name === 'retrieve_authorized_knowledge' ? 'knowledge'
        : name === 'search_current_web' ? 'search' : name === 'browse_in_sandbox' ? 'browser'
        : name === 'execute_in_sandbox' ? 'compute' : name.startsWith('mcp_') ? 'mcp'
        : ['discover_skills', 'load_skill'].includes(name) ? 'skills' : 'processing';
      activeTools.set(String(event.data?.toolCallId ?? name), next);
      return publish(next);
    }
    if (event.type === 'retrieval.completed') return publish(Number(event.data?.sourceCount) > 0 ? 'knowledge_ready' : 'knowledge_checked');
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      activeTools.delete(String(event.data?.toolCallId ?? event.toolName ?? ''));
      return publish([...activeTools.values()].at(-1) ?? 'processing');
    }
  } };
}
