import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { detachedProcess, ProcessRun } from '../processes.ts';
import { pythonCommand } from '../python.ts';

const adapter = 'crates/app-server-diff/src/lib.rs';
type PatchResult = 'applied' | 'compile-error' | 'fallback';

/** Owns the optional compiler and waits for an acknowledgement from the managed PID. */
export class SubsecondBuilder {
	private readonly run: ProcessRun;
	private pid: string | undefined;
	private pending: ReturnType<typeof Promise.withResolvers<PatchResult>> | undefined;
	private accepting = true;
	private acceptedSource: Buffer | undefined;
	private readonly root: string;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(root: string, environment: NodeJS.ProcessEnv) {
		this.root = root;
		this.environment = environment;
		this.run = new ProcessRun(root, undefined, 5_000);
	}

	async start(): Promise<void> {
		const ready = Promise.withResolvers<void>();
		void ready.promise.catch(() => { });
		const { command, args } = pythonCommand(['-B', 'build/desktop/subsecond.py']);
		const child = spawn(command, args, { cwd: this.root, env: this.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: detachedProcess(this.environment) });
		for (const stream of [child.stdout, child.stderr]) {
			createInterface({ input: stream }).on('line', (line: string) => {
				console.log(line);
				const message = stripVTControlCharacters(line);
				const started = /managed App Server endpoint ready: .* \(pid (\d+)\)/u.exec(message);
				if (started && !this.pid) {
					this.pid = started[1];
					ready.resolve();
				}
				const patched = /\[ash-subsecond\] Diff patch applied to (\d+)/u.exec(message);
				if (patched && patched[1] === this.pid) this.pending?.resolve('applied');
				if (message.includes('Build failed') && !this.pid) {
					ready.reject(new Error('Subsecond App Server failed to start. See the dx output.'));
				}
				// The pinned dx prints Cargo's compiler messages after its failure header.
				// Retry only for a confirmed source error. Tool errors and lost acks fall back.
				if (this.pending && isAdapterCompilerError(message)) this.pending.resolve('compile-error');
				if (/\[ash-subsecond\] (?:Diff entry missing|Patch rejected|Full rebuild required)/u.test(message)) {
					this.pending?.resolve('fallback');
				}
			});
		}
		const exited = (error: Error): void => {
			this.accepting = false;
			this.pending?.resolve('fallback');
			ready.reject(error);
		};
		child.once('error', exited);
		child.once('exit', (code, signal) => exited(new Error(`Subsecond driver exited (${signal ?? code})`)));
		const timeout = setTimeout(() => ready.reject(new Error('Subsecond App Server startup timed out')), 10 * 60_000);
		try {
			await this.run.own(child);
			await ready.promise;
		} finally {
			clearTimeout(timeout);
		}
	}

	async build(files: readonly string[]): Promise<PatchResult> {
		if (!this.accepting || files.length !== 1 || files[0] !== adapter) return 'fallback';
		const source = await readFile(resolve(this.root, adapter)).catch(error => {
			if (error?.code === 'ENOENT') return undefined;
			throw error;
		});
		if (!source) return 'fallback';
		const mirror = resolve(this.root, '.build/desktop/subsecond/workspace', adapter);
		this.acceptedSource ??= await readFile(mirror);
		if (source.equals(this.acceptedSource)) return 'applied';
		if (source.equals(await readFile(mirror))) return 'compile-error';
		const result = this.pending = Promise.withResolvers<PatchResult>();
		const timeout = setTimeout(() => result.resolve('fallback'), 15_000);
		try {
			await writeFile(mirror, source);
			const outcome = await result.promise;
			if (outcome === 'applied') this.acceptedSource = source;
			return outcome;
		} finally {
			clearTimeout(timeout);
			this.pending = undefined;
		}
	}

	/** After a driver failure or an unsupported edit, only immutable generations publish. */
	disable(): void {
		this.accepting = false;
	}

	async stop(): Promise<void> {
		this.disable();
		this.pending?.resolve('fallback');
		await this.run.stop('SIGTERM');
	}
}

function isAdapterCompilerError(message: string): boolean {
	const line = message.trimStart();
	if (!line.startsWith('{"$message_type":"diagnostic",')) return false;
	try {
		const diagnostic = JSON.parse(line) as { level?: string; spans?: { file_name?: string; is_primary?: boolean; }[]; };
		return diagnostic.level === 'error' && Array.isArray(diagnostic.spans)
			&& diagnostic.spans.some(span => span?.is_primary === true && span.file_name === adapter);
	} catch {
		return false;
	}
}
