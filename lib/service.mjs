import { ProjectStore } from './store.mjs';
import { Memory } from './memory.mjs';
import { Persona } from './persona.mjs';
import { readBaseline } from './project.mjs';
import { validateCore } from './core.mjs';

export const READ_ACTIONS = new Set(['status', 'persona', 'history', 'list', 'inspect', 'recall']);
export const MEMORY_ACTIONS = [...READ_ACTIONS, 'remember', 'reinforce', 'correct', 'forget', 'consolidate'];
export const PERSONA_ACTIONS = ['persona', 'history', 'propose'];
const CORE_ACTIONS = ['core', 'core-set', 'core-clear'];
export const OPERATOR_ACTIONS = [...new Set([...MEMORY_ACTIONS, ...PERSONA_ACTIONS, 'approve', 'reject', 'revert', ...CORE_ACTIONS])];

export function createService(binding, options = {}) {
  const store = new ProjectStore({ ...binding, ...options });
  return { binding, store, memory: new Memory(store, options), persona: new Persona(store, readBaseline(binding), options) };
}

export function dispatch(service, action, input = {}, { operator = false } = {}) {
  if (!OPERATOR_ACTIONS.includes(action)) throw new Error('未知的 OMP Echo Memory 操作');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('操作参数必须是 JSON 对象');
  if (['approve', 'reject', 'revert'].includes(action) && !operator) throw new Error('人格审批只能由用户通过 /omp-echo-memory 命令或项目 CLI 执行');
  if (CORE_ACTIONS.includes(action) && !operator) throw new Error('核心身份仅可通过本机操作者命令管理');
  switch (action) {
    case 'core': return service.store.read().core ?? null;
    case 'core-set': {
      const core = validateCore(input);
      return service.store.update(state => { state.core = core; return core; });
    }
    case 'core-clear':
      return service.store.update(state => { state.core = null; return null; });
    case 'status': {
      const state = service.store.read();
      return {
        projectRoot: service.binding.projectRoot, projectId: service.binding.projectId,
        dataFile: service.store.file, memories: state.memories.length,
        pendingChanges: state.personaChanges.filter(change => change.status === 'pending').length,
        automaticCapture: false, recallReinforces: false,
      };
    }
    case 'persona': return service.persona.get();
    case 'history': return service.persona.history();
    case 'list': return service.memory.list(input);
    case 'inspect': return service.memory.inspect(input.id);
    case 'recall': return service.memory.recall(input);
    case 'remember': return service.memory.remember(input);
    case 'reinforce': return service.memory.reinforce(input);
    case 'correct': return service.memory.correct(input);
    case 'forget': return service.memory.forget(input.id);
    case 'consolidate': return service.memory.consolidate(input);
    case 'propose': return service.persona.propose(input);
    case 'approve': return service.persona.approve(input.id);
    case 'reject': return service.persona.reject(input.id);
    case 'revert': return service.persona.revert(input.id);
  }
}

export function parseOperatorCommand(text) {
  const value = String(text || '').trim();
  if (!value || value === 'help') return { action: 'help', input: {} };
  const gap = value.search(/\s/);
  const action = gap < 0 ? value : value.slice(0, gap);
  const tail = gap < 0 ? '' : value.slice(gap).trim();
  if (!OPERATOR_ACTIONS.includes(action)) throw new Error('未知操作；使用 /omp-echo-memory help 查看用法');
  if (['approve', 'reject', 'revert', 'inspect', 'forget'].includes(action) && tail && !tail.startsWith('{')) {
    return { action, input: { id: tail } };
  }
  if (action === 'recall' && tail && !tail.startsWith('{')) return { action, input: { query: tail } };
  let input = {};
  if (tail) {
    try { input = JSON.parse(tail); } catch { throw new Error('参数不是有效 JSON；请使用双引号'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是 JSON 对象');
  }
  return { action, input };
}

export const HELP = `OMP Echo Memory（仅绑定项目）
/omp-echo-memory status | persona | history | list
/omp-echo-memory core（读取独立核心身份）
/omp-echo-memory core-set {"qq":"123456789","relationship":"关系","address":"称呼","meaning":"关系与称呼的含义"}（完整替换）
/omp-echo-memory core-clear（清除核心身份；以上三项仅限本机操作者，不是模型工具）
/omp-echo-memory remember {"content":"喜欢简短中文回复","type":"preference","source":"user","evidence":"用户明确要求"}
/omp-echo-memory recall 关键词（也可 JSON 指定 includeDormant:true）
/omp-echo-memory inspect 记忆ID
/omp-echo-memory reinforce {"id":"记忆ID","eventId":"独立事件ID","evidence":"新的确认依据"}
/omp-echo-memory correct {"id":"记忆ID","content":"更正内容","evidence":"用户更正"}
/omp-echo-memory consolidate {"ids":["记忆ID1","记忆ID2"],"summary":"共同经验","evidence":"整理依据"}
/omp-echo-memory forget 记忆ID（不可逆，连同派生记忆及相关成长内容删除）
/omp-echo-memory propose {"trait":"collaboration","description":"排障先检查连接","reason":"共同经验","evidenceIds":["记忆ID"]}
/omp-echo-memory approve 提案ID | reject 提案ID | revert 提案ID
初始人格在 omp-echo-memory/persona.json；不自动采集整段聊天，不自动批准成长。`;
