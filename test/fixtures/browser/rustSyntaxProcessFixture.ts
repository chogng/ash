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

export async function attachRustSyntax(page: Page): Promise<() => Promise<void>> {
	const profile = await mkdtemp(resolve(tmpdir(), 'ash-browser-syntax-'));
	let child: ChildProcessWithoutNullStreams | undefined;
	let lifecycle = Promise.resolve();
	let delivery = Promise.resolve();
	let stderr = '';
	let disposed = false;
	const emit = (event: string, payload: unknown): Promise<void> => page.evaluate(({ event, payload }) => window.__rustSyntaxEvent(event, payload), { event, payload });
	async function stop(): Promise<void> {
		const previous = child;
		child = undefined;
		if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
		if (!previous.pid) { previous.stdin.destroy(); return; }
		await new Promise<void>(done => {
			const timer = setTimeout(() => previous.kill(), 3000);
			previous.once('close', () => { clearTimeout(timer); done(); });
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
				if (!child?.stdin.writable) throw new Error(`Rust syntax connection is closed: ${stderr}`);
				child.stdin.write((payload as { frame: string; }).frame + '\n');
				return;
			}
			lifecycle = lifecycle.then(async () => {
				await stop();
				if (disposed || event === 'ash:app-server:disconnect') return;
				if (event !== 'ash:app-server:connect') throw new Error(`Unexpected syntax transport event: ${event}`);
				const executable = process.env.ASH_TEST_SYNTAX_APP_SERVER;
				if (!executable) throw new Error('Run Rust syntax browser tests through pnpm test:editor:browser so the matching backend is prepared.');
				const current = child = spawn(executable, ['--listen', 'stdio://'], {
					stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ASH_HOME: profile, ASH_WORKSPACE_ROOT: profile },
				});
				current.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-8192); });
				current.once('exit', () => {
					if (child === current) {
						child = undefined;
						void emit('ash:app-server:closed', { reason: stderr }).catch(() => undefined);
					}
				});
				current.once('error', error => { void emit('ash:app-server:closed', { reason: String(error) }).catch(() => undefined); });
				createInterface({ input: current.stdout }).on('line', frame => {
					delivery = delivery.then(async () => {
						if (child === current && !page.isClosed()) await emit('ash:app-server:frame', { frame });
					}).catch(error => { stderr = String(error); });
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
