import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectStore } from '../lib/store.mjs';
import { loadProject, ensureRuntime, assertSessionScope, runtimePaths } from '../lib/project.mjs';
import { createService, dispatch } from '../lib/service.mjs';
import { buildLaunchPlan } from '../launch.mjs';
import { fixture } from './fixture.mjs';

const entry = { content: '用户偏好清淡饮食', type: 'preference', source: 'user', evidence: '用户明确确认' };

test('fresh reads leave disk untouched; persisted data survives reconstruction and failed transactions', t => {
  const f = fixture(t);
  const a = new ProjectStore(f);
  assert.deepEqual(a.read().memories, []);
  assert.equal(existsSync(join(f.pluginDir, '.runtime')), false);
  const service = createService(f);
  const memory = service.memory.remember(entry);
  assert.equal(createService(f).memory.inspect(memory.id).content, entry.content);
  const before = readFileSync(a.file, 'utf8');
  assert.throws(() => a.update(state => { state.memories.length = 0; throw new Error('abort'); }), /abort/);
  assert.equal(readFileSync(a.file, 'utf8'), before);
  assert.equal(existsSync(join(a.runtimeDir, 'state.lock')), false);
  const snapshot = a.read(); snapshot.memories.length = 0;
  assert.equal(a.read().memories[0].id, memory.id);
});

test('another project and a copied state header are rejected rather than migrated', t => {
  const f = fixture(t);
  assert.throws(() => loadProject(f.other, f.pluginDir), /项目/);
  assert.equal(existsSync(join(f.pluginDir, '.runtime')), false);
  const store = new ProjectStore(f);
  store.update(state => state.memories.push({ id: 'sample' }));
  const state = store.read(); state.projectId = 'different-project';
  writeFileSync(store.file, JSON.stringify(state));
  assert.throws(() => store.read(), /身份/);
});

test('corruption and a live writer lock never reset or overwrite memory', t => {
  const f = fixture(t);
  const store = new ProjectStore(f);
  mkdirSync(store.runtimeDir);
  writeFileSync(store.file, '{broken');
  assert.throws(() => store.read());
  assert.equal(readFileSync(store.file, 'utf8'), '{broken');
  writeFileSync(join(store.runtimeDir, 'state.lock'), 'owner');
  assert.throws(() => store.update(() => {}), /占用/);
  assert.equal(readFileSync(join(store.runtimeDir, 'state.lock'), 'utf8'), 'owner');
});

test('a data-directory junction cannot redirect storage into another project', t => {
  const f = fixture(t);
  const outside = join(f.other, 'private'); mkdirSync(outside);
  const store = new ProjectStore(f);
  symlinkSync(outside, store.runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.read(), /链接|junction/);
  assert.throws(() => store.update(() => {}), /链接|junction/);
  assert.equal(existsSync(join(outside, 'state.json')), false);
});

test('launcher keeps project isolation while allowing only explicit local extension files', t => {
  const f = fixture(t);
  const inherited = { ...process.env, OMP_PROFILE: 'global-profile', PI_CODING_AGENT_DIR: f.other };
  for (const flag of ['--cwd', '--profile', '--session-dir', '--config', '--no-session']) {
    assert.throws(() => buildLaunchPlan(f, [flag, f.other], inherited));
  }
  assert.equal(existsSync(join(f.pluginDir, '.runtime')), false);
  assert.throws(() => buildLaunchPlan(f, ['-e', f.other], inherited));
  assert.throws(() => buildLaunchPlan(f, ['-e', join(f.pluginDir, 'index.mjs')], inherited));
  const plan = buildLaunchPlan(f, ['--mode', 'rpc'], inherited);
  assert.equal(plan.env.OMP_PROFILE, undefined);
  assert.equal(inherited.OMP_PROFILE, 'global-profile');
  assert.equal(plan.env.PI_CODING_AGENT_DIR, runtimePaths(f).agentDir);
  assert.equal(plan.cwd, f.projectRoot);
  assert.equal(plan.args[plan.args.indexOf('--session-dir') + 1], runtimePaths(f).sessionDir);
  const ctx = { cwd: f.root, agent: { kind: 'main' }, sessionManager: { getSessionFile: () => join(runtimePaths(f).sessionDir, 'run.jsonl') } };
  assert.doesNotThrow(() => assertSessionScope(ctx, f, plan.env));
  assert.throws(() => assertSessionScope({ ...ctx, cwd: f.other }, f, plan.env), /授权/);
  assert.throws(() => assertSessionScope({ ...ctx, agent: { kind: 'sub' } }, f, plan.env), /子 Agent/);
  assert.throws(() => assertSessionScope({ ...ctx, sessionManager: { getSessionFile: () => join(f.other, 'run.jsonl') } }, f, plan.env), /会话日志/);
});

test('project CLI rejects another cwd before opening or creating memory', t => {
  const f = fixture(t);
  const run = spawnSync(process.execPath, [join(f.pluginDir, 'cli.mjs'), 'status'], { cwd: f.other, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /未获授权/);
  assert.equal(existsSync(join(f.pluginDir, '.runtime')), false);
});

test('memory deletion removes growth and cannot be undone by reverting an old persona version', t => {
  const f = fixture(t);
  const service = createService(f);
  const memory = dispatch(service, 'remember', entry, { operator: true });
  const change = dispatch(service, 'propose', { trait: 'collaboration', description: '先确认饮食约束', reason: '明确偏好', evidenceIds: [memory.id] });
  assert.throws(() => dispatch(service, 'approve', { id: change.id }), /审批只能/);
  dispatch(service, 'approve', { id: change.id }, { operator: true });
  assert.equal(dispatch(service, 'persona').learned[0].description, '先确认饮食约束');
  const approvedVersion = dispatch(service, 'persona').version;
  dispatch(service, 'forget', { id: memory.id }, { operator: true });
  assert.equal(dispatch(service, 'inspect', { id: memory.id }), null);
  assert.deepEqual(dispatch(service, 'persona').learned, []);
  assert.ok(dispatch(service, 'persona').version > approvedVersion);
  assert.throws(() => dispatch(service, 'revert', { id: change.id }, { operator: true }));
  const disk = readFileSync(service.store.file, 'utf8');
  assert.ok(!disk.includes('清淡饮食') && !disk.includes('先确认饮食约束'));
});
