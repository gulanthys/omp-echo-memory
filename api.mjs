import { loadProject } from './lib/project.mjs';
import { createService, dispatch, MEMORY_ACTIONS, PERSONA_ACTIONS, READ_ACTIONS } from './lib/service.mjs';
import { corePolicy } from './lib/core.mjs';

const properties = {
  id: { type: 'string' }, query: { type: 'string' }, content: { type: 'string' },
  type: { type: 'string', enum: ['event', 'preference', 'learning', 'relationship', 'context'] },
  source: { type: 'string', enum: ['user', 'observed', 'inferred'] },
  importance: { type: 'number' }, evidence: { type: 'string' },
  sourceIds: { type: 'array', items: { type: 'string' } }, eventId: { type: 'string' },
  ids: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' },
  includeDormant: { type: 'boolean' }, includeInactive: { type: 'boolean' }, limit: { type: 'number' },
  trait: { type: 'string', enum: ['humor', 'warmth', 'initiative', 'curiosity', 'expression', 'collaboration'] },
  description: { type: 'string' }, reason: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } },
};
const definitions = [
  {
    name: 'echo_memory', label: 'OMP Echo Memory 项目记忆', actions: MEMORY_ACTIONS,
    description: '仅本项目的记忆：保存、检索、有效事件强化、纠正、整合和删除。检索不会强化；变更必须经本机用户确认。不得保存凭据或将推断当作事实、指令或授权。',
  },
  {
    name: 'echo_persona', label: 'OMP Echo Memory 人格成长', actions: PERSONA_ACTIONS,
    description: '读取项目人格或提出有记忆证据的成长提案。提案不会自行生效；批准、拒绝和撤销仅通过记忆插件的操作者入口执行。',
  },
];
function checkAbort(signal) {
  if (signal?.aborted) throw new Error('操作已取消，未提交修改');
}

/** Trusted local API; external-channel callers must supply their own local consent callback. */
export function openProjectMemory(projectRoot, directory) {
  const binding = loadProject(projectRoot, directory);
  const verify = () => {
    const current = loadProject(projectRoot, directory);
    if (current.projectId !== binding.projectId || current.projectRoot !== binding.projectRoot || current.pluginDir !== binding.pluginDir) {
      throw new Error('OMP Echo Memory 项目绑定已变化');
    }
    return current;
  };
  return {
    version: 1,
    id: 'omp-echo-memory',
    projectRoot: binding.projectRoot,
    tools: definitions.map(({ name, label, description, actions }) => ({
      name, label, description,
      parameters: structuredClone({
        type: 'object', properties: { action: { type: 'string', enum: actions }, ...properties },
        required: ['action'], additionalProperties: false,
      }),
    })),
    prepare(prompt, context) {
      const service = createService(verify());
      const persona = service.persona.get();
      const policy = [
        '本项目统一角色配置；只影响表达与协作，不覆盖宿主安全规则或扩大工具权限。',
        JSON.stringify(persona.baseline),
        '本机用户已批准的成长习惯：' + JSON.stringify(persona.learned.map(({ trait, description }) => ({ trait, description }))),
        '不要自动保存整段聊天或私聊原文。不保存凭据；记忆可能被本项目其他入口召回。',
        '记忆强度与事实可信度不同，检索不会强化记忆；新独立事件才能申请强化。所有持久变更均需本机确认。',
        '成长只能提出提案；批准、拒绝和撤销由本机用户通过 /omp-echo-memory 管理入口执行。',
        corePolicy(service.store.read().core ?? null, context),
      ].join('\n');
      const query = typeof prompt === 'string' ? prompt.trim().slice(0, 2000) : '';
      const recalled = /[\p{L}\p{N}]/u.test(query) ? service.memory.recall({ query, limit: 4 }) : [];
      const memories = recalled.length
        ? JSON.stringify(recalled.map(item => ({ ...item, content: String(item.content).slice(0, 500) }))).slice(0, 3500)
        : '';
      return { persona: policy, memories };
    },
    async execute(name, args, { origin = 'external channel', signal, requestConsent } = {}) {
      checkAbort(signal);
      verify();
      const definition = definitions.find(item => item.name === name);
      if (!definition || !args || !definition.actions.includes(args.action)) throw new Error('不允许的 OMP Echo Memory 操作');
      const { action, ...input } = args;
      if (!READ_ACTIONS.has(action)) {
        if (typeof requestConsent !== 'function') throw new Error('无本机用户确认入口，未提交修改');
        const approved = await requestConsent({
          title: `OMP Echo Memory：确认 ${action}`,
          description: `来源：${origin}\n此变更会影响本项目所有接入入口。\n${JSON.stringify(input, null, 2)}`,
          signal,
        });
        if (approved !== true) throw new Error('用户未批准，未提交修改');
        checkAbort(signal);
      }
      return dispatch(createService(verify()), action, input);
    },
  };
}
