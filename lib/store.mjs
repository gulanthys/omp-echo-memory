import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateCore } from './core.mjs';

export function canonical(path) {
  const value = realpathSync.native(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function inside(root, path) {
  const part = relative(resolve(root), resolve(path));
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

// Local filesystem containment, not a sandbox against a hostile local process.
export function assertPlainPath(root, target) {
  if (!inside(root, target)) throw new Error('路径不在本项目插件目录内');
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('插件配置和数据目录不允许符号链接或 junction');
    if (stat.isFile() && stat.nlink > 1) throw new Error('插件数据不允许硬链接');
  }
}

export function readPlainJson(root, file) {
  assertPlainPath(root, file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) throw new Error('配置或状态不是独立普通文件');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export class ProjectStore {
  constructor({ projectRoot, pluginDir, projectId, now = () => Date.now() }) {
    this.projectRoot = canonical(projectRoot);
    this.pluginDir = resolve(pluginDir);
    if (canonical(dirname(this.pluginDir)) !== this.projectRoot) throw new Error('插件必须直接位于绑定项目内');
    assertPlainPath(resolve(projectRoot), this.pluginDir);
    if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目身份');
    this.projectId = projectId;
    this.now = now;
    this.runtimeDir = join(this.pluginDir, '.runtime');
    this.file = join(this.runtimeDir, 'state.json');
  }

  initial() {
    return { version: 1, revision: 0, projectId: this.projectId, projectRoot: this.projectRoot, memories: [], personaChanges: [], personaEvents: [] };
  }

  validate(state) {
    if (!state || state.version !== 1 || state.projectId !== this.projectId || state.projectRoot !== this.projectRoot) {
      throw new Error('记忆的项目身份或物理路径不匹配，拒绝跨项目读取');
    }
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('记忆版本号损坏');
    for (const key of ['memories', 'personaChanges', 'personaEvents']) {
      if (!Array.isArray(state[key])) throw new Error(`记忆状态损坏：${key}`);
    }
    if (Object.hasOwn(state, 'core') && state.core !== null) validateCore(state.core);
    return state;
  }

  assertLocation() {
    if (canonical(dirname(this.pluginDir)) !== this.projectRoot) throw new Error('项目目录已变化');
    assertPlainPath(dirname(this.pluginDir), this.pluginDir);
    assertPlainPath(this.pluginDir, this.runtimeDir);
    assertPlainPath(this.pluginDir, this.file);
  }

  read() {
    this.assertLocation();
    try { return structuredClone(this.validate(readPlainJson(this.pluginDir, this.file))); }
    catch (error) {
      if (error.code === 'ENOENT') return this.initial();
      throw error;
    }
  }

  update(callback) {
    this.assertLocation();
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    this.assertLocation();
    const lockPath = join(this.runtimeDir, 'state.lock');
    assertPlainPath(this.pluginDir, lockPath);
    let lock;
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('记忆正被另一个操作占用；请稍后重试。崩溃残留锁须确认进程已退出后手动清理。');
      throw error;
    }
    const temp = join(this.runtimeDir, `state-${randomUUID()}.tmp`);
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: this.now() }));
      const state = this.read();
      const before = JSON.stringify(state);
      const result = callback(state);
      if (result && typeof result.then === 'function') throw new Error('存储事务不支持异步回调');
      this.validate(state);
      if (JSON.stringify(state) === before) return structuredClone(result);
      state.revision++;
      // Remove abandoned snapshots only while owning the writer lock.
      for (const name of readdirSync(this.runtimeDir)) {
        if (/^state-[0-9a-f-]+\.tmp$/.test(name)) {
          const old = join(this.runtimeDir, name);
          assertPlainPath(this.pluginDir, old);
          unlinkSync(old);
        }
      }
      this.assertLocation();
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state, null, 2) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      this.assertLocation();
      renameSync(temp, this.file);
      return structuredClone(result);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}
