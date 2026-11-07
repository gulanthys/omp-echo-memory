import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../lib/store.mjs';

export const baseline = {
  name: '项目助手', identity: '可靠的共同工作伙伴', traits: ['有好奇心'],
  style: ['自然中文'], boundaries: ['不改变操作权限'], examples: [{ user: '先做事', assistant: '好，先核验目标。' }],
};

export function fixture(t) {
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'omp-echo-memory-'));
  const pluginDir = join(root, 'omp-echo-memory');
  mkdirSync(pluginDir);
  cpSync(new URL('../lib', import.meta.url), join(pluginDir, 'lib'), { recursive: true });
  for (const name of ['index.mjs', 'api.mjs', 'launch.mjs', 'cli.mjs', 'persona.example.json']) cpSync(new URL(`../${name}`, import.meta.url), join(pluginDir, name));
  const projectId = 'test-project-' + root.split(/[\\/]/).at(-1);
  writeFileSync(join(pluginDir, 'project.json'), JSON.stringify({ version: 1, projectId, projectRoot: root }));
  writeFileSync(join(pluginDir, 'persona.json'), JSON.stringify(baseline));
  const other = join(root, 'other-project');
  mkdirSync(other);
  const result = { root, pluginDir, other, projectId, projectRoot: canonical(root) };
  if (t) t.after(() => {
    if (process.cwd().toLowerCase().startsWith(root.toLowerCase())) process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });
  return result;
}

export async function loadFixtureExtension(f) {
  return (await import(pathToFileURL(join(f.pluginDir, 'index.mjs')).href)).default;
}
