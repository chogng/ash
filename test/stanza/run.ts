import { constants, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename, resolve } from 'node:path';
import sirv from 'sirv';
import { collectTests, playwrightArguments } from '../../build/playwright.ts';
import { withProcessRun } from '../../build/processes.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const args = playwrightArguments(process.argv.slice(2));
const noCompile = args[0] === '--no-compile';
if (noCompile) args.shift();
const cli = ['node_modules/@playwright/test/cli.js', 'test', '--config', 'test/stanza/playwright.config.ts', ...args];

await withProcessRun(repositoryRoot, async (run, environment) => {
	if (!(await collectTests(run, cli, args, environment))) return;
	const outputParent = resolve(repositoryRoot, '.build/desktop');
	mkdirSync(outputParent, { recursive: true });
	const assetsDirectory = mkdtempSync(resolve(outputParent, 'stanza-'));
	const resultsDirectory = resolve(outputParent, 'playwright', basename(assetsDirectory));
	let server: Server | undefined;
	try {
		if (noCompile) {
			// Keep this run's product assets stable if another build replaces the shared output.
			cpSync(resolve(outputParent, 'stanza'), assetsDirectory, {
				recursive: true,
				mode: constants.COPYFILE_FICLONE,
			});
		} else {
			const pnpm = process.env.npm_execpath;
			if (!pnpm) throw new Error('Run this command through pnpm test:stanza.');
			const buildArgs = ['run', 'build:stanza', '--outDir', assetsDirectory];
			const build = /\.[cm]?js$/u.test(pnpm)
				? await run.command(process.execPath, [pnpm, ...buildArgs], environment)
				: await run.command(pnpm, buildArgs, environment);
			if (build.code !== 0) {
				process.exitCode = build.code;
				return;
			}
		}
		server = createServer(sirv(assetsDirectory, { etag: true }));
		await new Promise<void>((resolveListening, reject) => {
			server!.once('error', reject);
			server!.listen(0, '127.0.0.1', () => {
				server!.off('error', reject);
				resolveListening();
			});
		});
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Stanza test server requires a TCP address');
		const baseURL = `http://127.0.0.1:${address.port}`;
		console.log(`Stanza distribution: ${baseURL}\nStanza test results: ${resultsDirectory}`);
		process.exitCode = (
			await run.command(process.execPath, cli, {
				...environment,
				ASH_STANZA_BASE_URL: baseURL,
				ASH_STANZA_RUN_DIRECTORY: resultsDirectory,
			})
		).code;
	} finally {
		if (server) {
			const closed = new Promise<void>(resolveClosed => server!.close(() => resolveClosed()));
			server.closeAllConnections();
			await closed;
		}
		rmSync(assetsDirectory, { recursive: true, force: true });
	}
});
