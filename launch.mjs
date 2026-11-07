import { statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { assertPlainPath, canonical, inside } from './lib/store.mjs';
import { loadProject, ensureRuntime } from './lib/project.mjs';

export function buildLaunchPlan(binding, args = [], environment = process.env) {
  const options = [], extensions = [];
  const own = resolve(binding.pluginDir, 'index.mjs');
  const extensionKeys = new Set([canonical(own)]);
  const values = { '--mode': new Set(['text', 'json', 'rpc', 'rpc-ui']), '--thinking': new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']) };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-ui') options.push(flag);
    else if (flag === '-e' || flag === '--extension') {
      const file = args[++i];
      if (!file || file.startsWith('-')) throw new Error(`${flag} 缺少有效值`);
      const absolute = resolve(binding.projectRoot, file);
      assertPlainPath(binding.projectRoot, absolute);
      if (!inside(binding.projectRoot, absolute) || !/\.(?:[cm]?js|tsx?)$/i.test(absolute) || !statSync(absolute).isFile()) throw new Error('扩展必须是项目内 JavaScript/TypeScript 普通文件');
      const key = canonical(absolute);
      if (extensionKeys.has(key)) throw new Error('扩展重复');
      extensionKeys.add(key);
      extensions.push(absolute);
    } else if (['--mode', '--thinking', '--model'].includes(flag)) {
      const value = args[++i];
      if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`${flag} 缺少有效值`);
      if (values[flag] && !values[flag].has(value)) throw new Error(`${flag} 的值无效`);
      options.push(flag, value);
    } else throw new Error(`启动器不允许 ${flag}；仅支持 --model、--thinking、--mode、--no-ui 和项目内扩展`);
  }
  const paths = ensureRuntime(binding);
  assertPlainPath(binding.pluginDir, paths.overlay);
  writeFileSync(paths.overlay, 'memory:\n  backend: off\nautolearn:\n  enabled: false\n', { encoding: 'utf8', mode: 0o600 });
  const env = { ...environment, OMP_ECHO_MEMORY_PROJECT_ROOT: binding.projectRoot, OMP_ECHO_MEMORY_PROJECT_ID: binding.projectId,
    OMP_PROJECT_ROOT: binding.projectRoot, OMP_PROJECT_AGENT_DIR: paths.agentDir, OMP_PROJECT_SESSION_DIR: paths.sessionDir,
    PI_CODING_AGENT_DIR: paths.agentDir, PI_NO_TITLE: '1' };
  delete env.OMP_PROFILE;
  const argv = ['--cwd', binding.projectRoot, '--session-dir', paths.sessionDir, '--config', paths.overlay, '--no-extensions',
    '-e', own, ...extensions.flatMap(file => ['-e', file]), '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title',
    '--approval-mode', 'always-ask', ...options];
  return { command: 'omp', args: argv, cwd: binding.projectRoot, env };
}

export function launch(args = process.argv.slice(2)) {
  const binding = loadProject(process.cwd());
  const plan = buildLaunchPlan(binding, args);
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit', shell: false });
  child.on('error', error => { console.error(`无法启动 omp：${error.message}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { launch(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
