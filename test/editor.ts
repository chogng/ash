import { resolve } from 'node:path';
import { withProcessRun } from '../build/processes.ts';

// Unit and Playwright filters have different meanings. Reject ambiguous forwarding
// before the first command can start an unfiltered suite.
if (process.argv.length > 2) throw new Error('test:editor takes no filters. Use test:editor:unit, test:editor:browser or test:stanza for a targeted run.');
await withProcessRun(resolve(import.meta.dirname, '..'), async (run, environment) => {
	const pnpm = process.env.npm_execpath;
	if (!pnpm) throw new Error('Run this command through pnpm test:editor.');
	for (const script of ['test:editor:unit', 'test:editor:browser', 'test:stanza']) {
		const result = /\.[cm]?js$/u.test(pnpm)
			? await run.command(process.execPath, [pnpm, 'run', script], environment)
			: await run.command(pnpm, ['run', script], environment);
		if (result.code !== 0) { process.exitCode = result.code; return; }
	}
});
