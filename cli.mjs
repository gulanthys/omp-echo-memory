import { pathToFileURL } from 'node:url';
import { initializeProject, loadProject } from './lib/project.mjs';
import { createService, dispatch, HELP, parseOperatorCommand } from './lib/service.mjs';

export function runCli(args = process.argv.slice(2)) {
  if (args[0] === 'init') {
    if (args.length !== 1) throw new Error('init 不接受参数；不会自动迁移或重新绑定旧数据');
    return initializeProject(process.cwd());
  }
  const binding = loadProject(process.cwd());
  const command = args.length > 1 ? `${args[0]} ${args.slice(1).join(' ')}` : (args[0] || 'help');
  const { action, input } = parseOperatorCommand(command);
  if (action === 'help') return { help: HELP, scope: binding.projectRoot };
  return dispatch(createService(binding), action, input, { operator: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(runCli(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
