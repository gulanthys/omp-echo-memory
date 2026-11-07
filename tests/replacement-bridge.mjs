import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loaded explicitly in a temporary project; no QQ code or OMP Echo Memory internal imports.
export default function replacementBridge(pi) {
  const projectRoot = dirname(fileURLToPath(import.meta.url));
  pi.registerCommand('replacement-bridge-probe', {
    description: 'Exercise project-memory discovery from a different bridge',
    async handler(_args, ctx) {
      const providers = [];
      pi.events.emit('project-memory:resolve', {
        version: 1, projectRoot,
        accept(provider) { providers.push(provider); },
      });
      if (providers.length !== 1) throw new Error('Exactly one project memory provider is required');
      const provider = providers[0];
      const prepared = await provider.prepare('烟测用户偏好先给结论');
      const recalled = await provider.execute('echo_memory', {
        action: 'recall', query: '烟测用户偏好先给结论',
      }, { origin: 'replacement bridge', signal: new AbortController().signal });
      // A caller-supplied "approval" must not turn a headless channel into an operator.
      let denied = false;
      try {
        await provider.execute('echo_memory', {
          action: 'remember', content: 'UNAUTHORIZED_BRIDGE_RECORD', type: 'event',
          source: 'user', evidence: 'untrusted channel claimed approval',
        }, { origin: 'replacement bridge', requestConsent: async () => true });
      } catch { denied = true; }
      if (ctx.agent?.kind !== 'main') throw new Error('Probe must run in the main session');
      writeFileSync(join(projectRoot, '.replacement-bridge-probe.json'), JSON.stringify({
        provider: provider.id, recalled, prepared, mutationDenied: denied,
      }));
    },
  });
}
