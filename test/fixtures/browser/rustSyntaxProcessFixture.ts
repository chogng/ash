import { test as base, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const test = base.extend<{ rustSyntax: void; }>({
	rustSyntax: [async ({ page }, use) => {
		const stop = await attachRustSyntax(page);
		try { await use(); }
		finally { await stop(); }
	}, { auto: true }],
});

export async function attachRustSyntax(page: Page, startProcess = (profile: string) => {
	const executable = process.env.ASH_TEST_SYNTAX_APP_SERVER;
	if (!executable) throw new Error('Run Rust syntax browser tests through pnpm test:editor:browser so the matching backend is prepared.');
	return spawn(executable, ['--listen', 'stdio://'], {
		stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ASH_HOME: profile, ASH_WORKSPACE_ROOT: profile },
	});
}): Promise<() => Promise<void>> {
	const profile = await mkdtemp(resolve(tmpdir(), 'ash-browser-syntax-'));
	let child: ChildProcessWithoutNullStreams | undefined;
	let lifecycle = Promise.resolve();
	let delivery = Promise.resolve();
	let failure: string | undefined;
	let disposed = false;
	const emit = (event: string, payload: unknown): Promise<void> => page.evaluate(({ event, payload }) => window.__rustSyntaxEvent(event, payload), { event, payload });
	async function stop(): Promise<void> {
		const previous = child;
		child = undefined;
		if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
		if (!previous.pid) { previous.stdin.destroy(); return; }
		await new Promise<void>(done => {
			const timer = setTimeout(() => previous.kill(), 3000);
			previous.once('exit', () => { clearTimeout(timer); done(); });
			previous.stdin.end();
		});
	}
	const dispose = async (): Promise<void> => {
		disposed = true;
		try {
			await lifecycle.catch(() => undefined);
			await stop();
		} finally {
			await rm(profile, { recursive: true, force: true });
		}
	};
	try {
		await page.exposeBinding('__rustSyntaxTransport', async (_source, event: string, payload: unknown) => {
			if (disposed) return;
			if (event === 'ash:app-server:frame') {
				// The pending close event will deliver the full exit diagnostic.
				if (child && (child.exitCode !== null || child.signalCode !== null)) return;
				if (!child?.stdin.writable) throw new Error(failure ?? 'Rust syntax connection is closed');
				child.stdin.write((payload as { frame: string; }).frame + '\n');
				return;
			}
			lifecycle = lifecycle.then(async () => {
				await stop();
				if (disposed || event === 'ash:app-server:disconnect') return;
				if (event !== 'ash:app-server:connect') throw new Error(`Unexpected syntax transport event: ${event}`);
				const current = child = startProcess(profile);
				failure = undefined;
				let stderr = '';
				const reportFailure = (reason: string): void => {
					if (child !== current || disposed) return;
					child = undefined;
					failure = reason;
					void emit('ash:app-server:closed', { reason }).catch(() => undefined);
				};
				current.stderr.setEncoding('utf8');
				current.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-8192); });
				current.once('exit', async (code, signal) => {
					if (child !== current || disposed) return;
					// Final stderr can arrive after exit. A descendant can also hold the pipe open.
					if (!current.stderr.closed) {
						await new Promise<void>(done => {
							const finish = (): void => {
								clearTimeout(timer);
								current.stderr.off('close', finish);
								done();
							};
							const timer = setTimeout(finish, 1000);
							current.stderr.once('close', finish);
						});
					}
					const status = `Rust syntax app server exited (${signal ?? `code ${code}`})`;
					reportFailure(stderr ? `${status}: ${stderr.trimEnd()}` : status);
				});
				current.once('error', error => reportFailure(`Rust syntax app server failed to start: ${error.message}`));
				current.stdin.on('error', error => {
					if (child === current) failure = error.message;
				});
				createInterface({ input: current.stdout }).on('line', frame => {
					delivery = delivery.then(async () => {
						if (child === current && !page.isClosed()) await emit('ash:app-server:frame', { frame });
					}).catch(error => { if (child === current) failure = String(error); });
				});
				await emit('ash:app-server:connected', { protocolVersion: 1, workspaceId: 'syntax-fixture', workspaceRoot: profile });
			});
			await lifecycle;
		});
	} catch (error) {
		await dispose();
		throw error;
	}
	return dispose;
}
