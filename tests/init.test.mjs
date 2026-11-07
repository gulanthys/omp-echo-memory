import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeProject } from '../lib/project.mjs';
import { createService, dispatch } from '../lib/service.mjs';
import { fixture } from './fixture.mjs';

function fresh(t) {
  const f = fixture(t);
  for (const name of ['project.json', 'persona.json']) rmSync(join(f.pluginDir, name));
  return f;
}

function cli(f, ...args) {
  return spawnSync(process.execPath, [join(f.pluginDir, 'cli.mjs'), ...args], { cwd: f.root, encoding: 'utf8' });
}

test('fresh checkout initializes through CLI and supports read-only status without runtime creation', t => {
  const f = fresh(t);
  const initialized = cli(f, 'init');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).initialized, true);
  assert.equal(cli(f, 'status').status, 0);
  assert.equal(cli(f, 'core').stdout.trim(), 'null');
  assert.equal(existsSync(join(f.pluginDir, '.runtime')), false);
});

test('repeat init preserves configuration and all existing runtime bytes', t => {
  const f = fixture(t);
  const service = createService(f);
  service.memory.remember({ content: '先给结论', type: 'preference', source: 'user', evidence: '用户确认' });
  dispatch(service, 'core-set', { qq: '123456789', relationship: '协作者', address: '同伴', meaning: '仅测试关系' }, { operator: true });
  const sentinel = join(f.pluginDir, '.runtime', 'keep.bin');
  writeFileSync(sentinel, Buffer.from([0, 255, 7]));
  const files = ['project.json', 'persona.json', '.runtime/state.json', '.runtime/keep.bin'];
  const before = files.map(name => readFileSync(join(f.pluginDir, name)));
  assert.equal(initializeProject(f.root, f.pluginDir).initialized, false);
  for (let i = 0; i < files.length; i++) assert.deepEqual(readFileSync(join(f.pluginDir, files[i])), before[i]);
  assert.equal(cli(f, 'status').status, 0);
  assert.equal(JSON.parse(cli(f, 'core').stdout).address, '同伴');
});

test('foreign binding rejects init without changing configuration or creating persona', t => {
  const f = fixture(t);
  const file = join(f.pluginDir, 'project.json');
  const foreign = JSON.stringify({ version: 1, projectId: f.projectId, projectRoot: f.other });
  writeFileSync(file, foreign);
  rmSync(join(f.pluginDir, 'persona.json'));
  assert.throws(() => initializeProject(f.root, f.pluginDir), /另一个项目/);
  assert.equal(readFileSync(file, 'utf8'), foreign);
  assert.equal(existsSync(join(f.pluginDir, 'persona.json')), false);
});

test('orphaned runtime and mismatched state never get rebound by init', t => {
  const f = fresh(t);
  const runtime = join(f.pluginDir, '.runtime');
  mkdirSync(runtime);
  const state = join(runtime, 'state.json');
  writeFileSync(state, 'foreign data');
  assert.throws(() => initializeProject(f.root, f.pluginDir), /旧数据/);
  assert.equal(readFileSync(state, 'utf8'), 'foreign data');
  assert.equal(existsSync(join(f.pluginDir, 'project.json')), false);
  writeFileSync(join(f.pluginDir, 'project.json'), JSON.stringify({ version: 1, projectId: f.projectId, projectRoot: f.root }));
  writeFileSync(state, JSON.stringify({ version: 1, projectId: 'foreign', projectRoot: f.root }));
  assert.throws(() => initializeProject(f.root, f.pluginDir), /身份/);
  assert.equal(existsSync(join(f.pluginDir, 'persona.json')), false);
});

test('init enforces root cwd, linked paths and independent config files', t => {
  const f = fresh(t);
  assert.throws(() => initializeProject(f.other, f.pluginDir), /未获授权/);
  const persona = join(f.pluginDir, 'persona.json');
  symlinkSync(join(f.other, 'missing.json'), persona);
  assert.throws(() => initializeProject(f.root, f.pluginDir), /链接/);
  rmSync(persona);
  linkSync(join(f.pluginDir, 'persona.example.json'), persona);
  assert.throws(() => initializeProject(f.root, f.pluginDir), /硬链接/);
  assert.equal(existsSync(join(f.pluginDir, 'project.json')), false);
});

test('invalid existing persona is never overwritten or bound', t => {
  const f = fresh(t);
  const file = join(f.pluginDir, 'persona.json');
  writeFileSync(file, '{"name":"incomplete"}');
  assert.throws(() => initializeProject(f.root, f.pluginDir), /baseline/);
  assert.equal(readFileSync(file, 'utf8'), '{"name":"incomplete"}');
  assert.equal(existsSync(join(f.pluginDir, 'project.json')), false);
});

test('missing persona can be initialized without changing valid existing binding', t => {
  const f = fixture(t);
  const before = readFileSync(join(f.pluginDir, 'project.json'));
  rmSync(join(f.pluginDir, 'persona.json'));
  initializeProject(f.root, f.pluginDir);
  assert.deepEqual(readFileSync(join(f.pluginDir, 'project.json')), before);
  assert.equal(cli(f, 'persona').status, 0);
  assert.equal(existsSync(join(f.pluginDir, '.runtime')), false);
});

test('directory rename preserves project identity and read-only core/status access', t => {
  const f = fixture(t);
  dispatch(createService(f), 'core-set', { qq: '123456789', relationship: '协作者', address: '同伴', meaning: '仅测试关系' }, { operator: true });
  const stateBefore = readFileSync(join(f.pluginDir, '.runtime', 'state.json'));
  const bindingBefore = readFileSync(join(f.pluginDir, 'project.json'));
  const renamed = { ...f, pluginDir: join(f.root, 'renamed-memory') };
  renameSync(f.pluginDir, renamed.pluginDir);
  assert.equal(cli(renamed, 'status').status, 0);
  assert.equal(JSON.parse(cli(renamed, 'core').stdout).address, '同伴');
  assert.deepEqual(readFileSync(join(renamed.pluginDir, '.runtime', 'state.json')), stateBefore);
  assert.deepEqual(readFileSync(join(renamed.pluginDir, 'project.json')), bindingBefore);
});
