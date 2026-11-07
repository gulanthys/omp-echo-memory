import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fixture } from './fixture.mjs';
import { buildLaunchPlan } from '../launch.mjs';

const f = fixture();
const replacementBridge = join(f.root, 'replacement-bridge.mjs');
copyFileSync(new URL('./replacement-bridge.mjs', import.meta.url), replacementBridge);
const plan = buildLaunchPlan(f, ['-e', replacementBridge, '--mode', 'rpc', '--no-ui', '--model', 'omp-echo-memory-smoke/probe']);
let modelRequests = 0;
const endpoint = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(503).end('This probe must not call a model.');
});
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
writeFileSync(join(plan.env.PI_CODING_AGENT_DIR, 'models.yml'), JSON.stringify({
  providers: { 'omp-echo-memory-smoke': {
    baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, api: 'openai-completions',
    apiKey: 'local-smoke-only-not-a-credential',
    models: [{ id: 'probe', name: 'No-model command probe', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
  } },
}));
let running;
async function start(config = plan) {
  const child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  running = child;
  let errors = '', serial = 0;
  const pending = new Map();
  const completed = new Map();
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-8000); });
  child.on('error', error => ready.reject(error));
  child.on('exit', code => {
    exited.resolve(code);
    for (const item of pending.values()) item.reject(new Error(`omp exited ${code}: ${errors}`));
    for (const item of completed.values()) item.reject(new Error(`omp exited ${code}: ${errors}`));
    ready.reject(new Error(`omp exited before ready: ${errors}`));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === 'ready') ready.resolve();
    if (frame.type === 'response' && pending.has(frame.id)) {
      const item = pending.get(frame.id); pending.delete(frame.id);
      if (frame.success === false) item.reject(new Error(JSON.stringify(frame)));
      else item.resolve(frame);
    }
    if (frame.type === 'prompt_result' && completed.has(frame.id)) {
      const item = completed.get(frame.id);
      completed.delete(frame.id);
      if (frame.status !== 'completed') item.reject(new Error(JSON.stringify(frame)));
      else item.resolve(frame);
    }
  });
  async function deadline(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC deadline: ${errors}`)), 60000); })]); }
    finally { clearTimeout(timer); }
  }
  await deadline(ready.promise);
  return {
    async request(type, data = {}) {
      const id = `probe-${++serial}`;
      const item = Promise.withResolvers(); pending.set(id, item);
      const command = type === 'prompt' ? Promise.withResolvers() : undefined;
      if (command) completed.set(id, command);
      child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n');
      const response = await deadline(item.promise);
      if (command) await deadline(command.promise);
      return response;
    },
    async close() { child.stdin.end(); const code = await deadline(exited.promise); assert.equal(code, 0, errors); running = undefined; },
  };
}
const readState = () => JSON.parse(readFileSync(join(f.pluginDir, '.runtime', 'state.json'), 'utf8'));
try {
  let rpc = await start();
  const commands = await rpc.request('get_available_commands');
  assert.ok(JSON.stringify(commands.data).includes('"omp-echo-memory"'), JSON.stringify(commands));
  await rpc.request('prompt', { message: '/omp-echo-memory remember ' + JSON.stringify({ content: '烟测用户偏好先给结论', type: 'preference', source: 'user', evidence: '隔离烟测明确输入' }) });
  const first = readState().memories[0]; assert.equal(first.content, '烟测用户偏好先给结论');
  await rpc.request('prompt', { message: '/replacement-bridge-probe' });
  const probe = JSON.parse(readFileSync(join(f.root, '.replacement-bridge-probe.json'), 'utf8'));
  assert.equal(probe.provider, 'omp-echo-memory');
  assert.ok(probe.recalled.some(memory => memory.id === first.id));
  assert.ok(probe.prepared.memories.includes(first.id));
  assert.equal(probe.mutationDenied, true);
  assert.equal(readState().memories.some(memory => memory.content === 'UNAUTHORIZED_BRIDGE_RECORD'), false);
  await rpc.request('prompt', { message: '/omp-echo-memory propose ' + JSON.stringify({ trait: 'expression', description: '先给结论，再补必要细节', reason: '明确偏好', evidenceIds: [first.id] }) });
  const change = readState().personaChanges[0]; assert.equal(change.status, 'pending');
  await rpc.request('prompt', { message: `/omp-echo-memory approve ${change.id}` });
  assert.equal(readState().personaChanges[0].status, 'approved');
  await rpc.close();
  rpc = await start();
  await rpc.request('prompt', { message: '/omp-echo-memory status' });
  assert.equal(readState().memories[0].id, first.id);
  await rpc.request('prompt', { message: `/omp-echo-memory forget ${first.id}` });
  assert.deepEqual(readState().memories, []);
  assert.deepEqual(readState().personaChanges, []);
  await rpc.close();
  const before = readFileSync(join(f.pluginDir, '.runtime', 'state.json'), 'utf8');
  const outside = { ...plan, cwd: f.other, args: [...plan.args] };
  outside.args[outside.args.indexOf('--cwd') + 1] = f.other;
  rpc = await start(outside);
  const inactive = await rpc.request('get_available_commands');
  assert.equal(JSON.stringify(inactive.data).includes('"omp-echo-memory"'), false);
  await rpc.close();
  assert.equal(readFileSync(join(f.pluginDir, '.runtime', 'state.json'), 'utf8'), before);
  assert.equal(modelRequests, 0, 'operator commands must not invoke the model');
  console.log(JSON.stringify({ realOmp: true, memoryWithoutQQ: true, replacementBridgeDiscovery: true, replacementBridgeRecall: true, headlessChannelCannotApproveMutation: true, projectCommands: true, saveApproveRestartForget: true, foreignProjectInactive: true, modelRequests, stateOnlyInTemporaryProject: true }, null, 2));
} finally {
  if (running?.pid && running.exitCode === null && running.signalCode === null) {
    const closed = new Promise(resolve => running.once('close', resolve));
    running.kill();
    await closed;
  }
  endpoint.closeAllConnections();
  await new Promise(resolve => endpoint.close(resolve));
  rmSync(f.root, { recursive: true, force: true });
}
