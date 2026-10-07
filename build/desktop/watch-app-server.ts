import { watchAppServer } from './appServer.ts';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--skip-initial')) throw new Error('Usage: watch-app-server.ts [--skip-initial]');
const stop = await watchAppServer({ skipInitial: args.includes('--skip-initial') });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
