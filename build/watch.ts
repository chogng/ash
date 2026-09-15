import { watchAppServer } from './lib/appServer.ts';
import { compilationTargets, watchCompilation } from './lib/compilation.ts';

const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  if (args.slice(1).some(arg => arg !== '--skip-initial')) throw new Error('Usage: watch.ts app-server [--skip-initial]');
  const stop = await watchAppServer({ skipInitial: args.includes('--skip-initial') });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else {
  const watcher = await watchCompilation(compilationTargets(args), ready => {
    if (ready) console.log('[compilation] Ready');
  });
  process.once('SIGINT', () => { void watcher.close(); });
  process.once('SIGTERM', () => { void watcher.close(); });
  await watcher.done;
}
