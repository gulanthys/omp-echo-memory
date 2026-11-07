import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlainPath, canonical, inside, ProjectStore, readPlainJson } from './store.mjs';
import { Persona } from './persona.mjs';

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function assertProjectCwd(cwd, pluginDir = PLUGIN_DIR) {
  const parent = dirname(resolve(pluginDir));
  if (canonical(cwd) !== canonical(parent)) throw new Error('OMP Echo Memory 只允许在绑定项目根目录运行；当前目录未获授权');
  assertPlainPath(parent, resolve(pluginDir));
}

export function loadProject(cwd, pluginDir = PLUGIN_DIR) {
  // Reject another project's request before opening project.json, persona or memory.
  assertProjectCwd(cwd, pluginDir);
  const config = readPlainJson(pluginDir, join(pluginDir, 'project.json'));
  if (config.version !== 1 || typeof config.projectId !== 'string' || !config.projectId.trim() || typeof config.projectRoot !== 'string') {
    throw new Error('project.json 缺少有效的项目绑定');
  }
  if (canonical(config.projectRoot) !== canonical(cwd)) throw new Error('project.json 绑定了另一个项目；复制插件不会自动迁移记忆');
  return { projectRoot: canonical(cwd), projectId: config.projectId, pluginDir: resolve(pluginDir) };
}

export function initializeProject(cwd, pluginDir = PLUGIN_DIR) {
  assertProjectCwd(cwd, pluginDir);
  const projectFile = join(pluginDir, 'project.json');
  const personaFile = join(pluginDir, 'persona.json');
  const templateFile = join(pluginDir, 'persona.example.json');
  const runtimeDir = join(pluginDir, '.runtime');
  for (const file of [projectFile, personaFile, templateFile, runtimeDir]) assertPlainPath(pluginDir, file);
  const bound = existsSync(projectFile);
  if (!bound && existsSync(runtimeDir)) {
    throw new Error('缺少 project.json 但存在 .runtime；拒绝为旧数据创建新绑定');
  }
  const binding = bound ? loadProject(cwd, pluginDir) : {
    projectRoot: canonical(cwd), projectId: randomUUID(), pluginDir: resolve(pluginDir),
  };
  const store = new ProjectStore(binding);
  // Validate all existing data before creating either missing configuration file.
  store.read();
  const hasPersona = existsSync(personaFile);
  const baseline = readPlainJson(pluginDir, hasPersona ? personaFile : templateFile);
  new Persona(store, baseline);
  if (!bound) {
    writeFileSync(projectFile, JSON.stringify({
      version: 1, projectId: binding.projectId, projectRoot: binding.projectRoot,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (!hasPersona) {
    writeFileSync(personaFile, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { ok: true, initialized: !bound, scope: binding.projectRoot };
}

export function runtimePaths(binding) {
  const root = join(binding.pluginDir, '.runtime');
  return { root, agentDir: join(root, 'omp'), sessionDir: join(root, 'sessions'), overlay: join(root, 'omp-config.yml') };
}

export function ensureRuntime(binding) {
  const paths = runtimePaths(binding);
  for (const path of [paths.root, paths.agentDir, paths.sessionDir]) {
    assertPlainPath(binding.pluginDir, path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    assertPlainPath(binding.pluginDir, path);
  }
  return paths;
}

function sameDirectory(left, right) {
  try { return typeof left === 'string' && canonical(left) === canonical(right); }
  catch { return false; }
}

function dedicatedPaths(binding, env) {
  if (env.OMP_PROFILE) return null;
  let paths;
  const generic = [env.OMP_PROJECT_ROOT, env.OMP_PROJECT_AGENT_DIR, env.OMP_PROJECT_SESSION_DIR].some(value => value !== undefined);
  if (generic) {
    if (!sameDirectory(env.OMP_PROJECT_ROOT, binding.projectRoot)
      || typeof env.OMP_PROJECT_AGENT_DIR !== 'string' || typeof env.OMP_PROJECT_SESSION_DIR !== 'string') return null;
    paths = { agentDir: resolve(env.OMP_PROJECT_AGENT_DIR), sessionDir: resolve(env.OMP_PROJECT_SESSION_DIR) };
  } else {
    if (env.OMP_ECHO_MEMORY_PROJECT_ID !== binding.projectId || !sameDirectory(env.OMP_ECHO_MEMORY_PROJECT_ROOT, binding.projectRoot)) return null;
    paths = runtimePaths(binding);
  }
  if (!sameDirectory(env.PI_CODING_AGENT_DIR, paths.agentDir)) return null;
  try {
    for (const path of [paths.agentDir, paths.sessionDir]) {
      if (!inside(binding.projectRoot, path) || sameDirectory(path, binding.projectRoot)) return null;
      assertPlainPath(binding.projectRoot, path);
    }
  } catch { return null; }
  return paths;
}

export function hasDedicatedEnvironment(binding, env = process.env) {
  return dedicatedPaths(binding, env) !== null;
}

export function assertSessionScope(ctx, binding, env = process.env) {
  assertProjectCwd(ctx?.cwd, binding.pluginDir);
  if (ctx?.agent?.kind !== 'main') throw new Error('子 Agent 不能读取或修改 OMP Echo Memory 的人格与记忆');
  const paths = dedicatedPaths(binding, env);
  if (!paths) throw new Error('请使用项目内专用启动器；禁止借用全局 omp 状态目录');
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (typeof sessionFile !== 'string' || !inside(paths.sessionDir, sessionFile) || resolve(sessionFile) === resolve(paths.sessionDir)) {
    throw new Error('会话日志必须保存在本项目的 .runtime/sessions 内');
  }
  assertPlainPath(binding.projectRoot, sessionFile);
}

export function readBaseline(binding) {
  return readPlainJson(binding.pluginDir, join(binding.pluginDir, 'persona.json'));
}
