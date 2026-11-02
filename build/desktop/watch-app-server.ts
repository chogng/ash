import { watchAppServer } from './appServer.ts';
import { resolve, join } from 'node:path';
import { LogFileWriter } from '../logFileWriter.ts';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--skip-initial')) throw new Error('Usage: watch-app-server.ts [--skip-initial]');
const logs = new LogFileWriter({ logsHome: resolve(import.meta.dirname, '../../.build/desktop/dev/app-server-build-logs'), maxFileBytes: 1024 * 1024, retainedSessions: 5 });
await logs.initialize();
await logs.cleanUpLogs();
// Cancellation may finish asynchronously. Flush after the build and its owned
// processes have drained, so the final failure/cancellation record is retained.
process.once('beforeExit', () => { void logs.close().catch(error => console.error('Failed to flush App Server build logs', error)); });
const stop = await watchAppServer({
	skipInitial: args.includes('--skip-initial'), buildLog: join(logs.sessionPath, 'main.log'),
	log: (event, detail, error) => {
		const level = error === undefined || event === 'Build cancelled' ? 'information' : 'error';
		const entry = { timestampMillis: Date.now(), processId: process.pid, level, category: 'app-server.build', event, ...detail, ...(error === undefined ? {} : { error: error instanceof Error ? error.stack ?? error.message : String(error) }) };
		const line = JSON.stringify(entry);
		if (level === 'error') console.error(`[app-server] ${line}`);
		else console.info(`[app-server] ${line}`);
		void logs.append('main', line + '\n').catch(error => console.error('Failed to persist App Server build log', error));
	},
});
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
