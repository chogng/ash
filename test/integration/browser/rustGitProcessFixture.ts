import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

/** Real SDK executable; only the browser's public client services are simulated. The
 * supervisor's authority and crash handling have separate Rust process tests. */
export async function attachRustGit(page: Page): Promise<() => Promise<void>> {
	let child: ChildProcessWithoutNullStreams | undefined;
	let incarnation = 0, requestId = 0;
	let stderr = '';

	const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; }>();
	const write = (value: unknown) => child!.stdin.write(`${JSON.stringify(value)}\n`);
	async function request(method: string, params?: unknown): Promise<unknown> {
		const id = ++requestId;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Rust Git ${method} timed out: ${stderr}`)); }, 15000);
			pending.set(id, { resolve: resolvePromise, reject, timer });
			write({ protocolVersion: 1, requestId: id, incarnation, activationGeneration: incarnation, method, ...(params === undefined ? {} : { params }) });
		});
	}
	let stopping: Promise<void> | undefined;
	function stop(): Promise<void> {
		if (stopping) return stopping;
		stopping = stopChild().finally(() => { stopping = undefined; });
		return stopping;
	}
	async function stopChild(): Promise<void> {
		if (!child) return;
		const previous = child;
		if (previous.exitCode !== null) { child = undefined; return; }
		try { await request('shutdown'); } finally {
			if (child === previous) child = undefined;
			previous.stdin.end();
			await new Promise<void>(resolvePromise => {
				if (previous.exitCode !== null) resolvePromise();
				else { previous.once('exit', () => resolvePromise()); setTimeout(() => previous.kill(), 3000).unref(); }
			});
		}
	}

	await page.exposeBinding('__rustGitRequest', async (_source, method: string, params: unknown) => {
		if (method === 'stop') { await stop(); return null; }
		if (method === 'start') {
			await stop();
			incarnation++; requestId = 0; stderr = '';
			const executable = process.env.ASH_TEST_GIT_EXTENSION ?? resolve(process.env.CARGO_TARGET_DIR?.trim() || '.build/cargo', 'ci-test', `ash-git-extension${process.platform === 'win32' ? '.exe' : ''}`);
			const current = child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
			current.once('error', error => {
				if (child === current) child = undefined;
				for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
				pending.clear();
			});
			current.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-8192); });
			current.stdin.on('error', error => {
				if (child !== current || stopping) return;
				for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
				pending.clear();
			});
			current.once('exit', code => {
				for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(`Rust Git exited ${code}: ${stderr}`)); }
				pending.clear();
			});
			createInterface({ input: current.stdout }).on('line', async line => {
				const frame = JSON.parse(line);
				if (frame.context && frame.callId) {
					let outcome;
					try {
						const value = await page.evaluate(async ({ operation, context }) => window.__rustGitClient(operation, context), frame);
						outcome = { Ok: value };
					} catch (error) { outcome = { Err: { code: 'cancelled', message: String(error) } }; }
					// Shutdown cancels SDK callbacks; browser work that finishes later
					// must not write to the retired process's pipe.
					if (child === current && !stopping && current.exitCode === null && !current.killed && current.stdin.writable) current.stdin.write(`${JSON.stringify({ context: frame.context, callId: frame.callId, outcome })}\n`);
				} else if (frame.requestId) {
					const job = pending.get(frame.requestId);
					if (!job) return;
					pending.delete(frame.requestId); clearTimeout(job.timer);
					if (frame.status === 'failure') job.reject(new Error(frame.body.message ?? JSON.stringify(frame.body)));
					else job.resolve(frame.body);
				}
			});
			await request('initialize', { extensionId: 'ash.git', runtimeApiVersion: 1 });
			const result = await request('activate', { extensionId: 'ash.git', package: { packageId: 'ash.git@0.1.0', packageDigest: `sha256:${'a'.repeat(64)}`, entrypoint: 'ash-git-extension' }, runtimeApiVersion: 1, activationEvents: ['onStartupFinished'], capabilities: ['command', 'sourceControl', 'terminalProfileProvider'], initialization: params }) as { body: { registrations: unknown[]; }; };
			return { incarnation, registrations: result.body.registrations };
		}
		if (method === 'invoke') { const result = await request('invoke', { ...(params as Record<string, unknown>), extensionId: 'ash.git' }) as { body: { payload: unknown; }; }; return result.body.payload; }
		throw new Error(`Unexpected Rust process fixture operation ${method}`);
	});
	return stop;
}
