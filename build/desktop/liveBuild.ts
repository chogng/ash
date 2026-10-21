import { type ChildProcess, spawn } from 'node:child_process';

import { pythonCommand } from '../python.ts';

/** Owns one build/analysis session. EOF releases its Cargo leases and RA child. */
export class LiveBuilder {

	private child: ChildProcess | undefined;
	private ready: Promise<void> | undefined;
	private exited: Promise<void> | undefined;
	private sequence = 0;
	private pending: { id: number; resolve: () => void; reject: (error: Error) => void; } | undefined;
	private readonly root: string;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(root: string, environment: NodeJS.ProcessEnv) {
		this.root = root;
		this.environment = environment;
	}

	async build(): Promise<void> {
		if (!this.child) this.start();
		await this.ready;
		const child = this.child;
		if (!child?.stdin || this.pending) throw new Error('live build session is unavailable or busy');
		const id = ++this.sequence;
		return new Promise<void>((resolve, reject) => {
			this.pending = { id, resolve, reject };
			child.stdin!.write(`${JSON.stringify({ protocol_version: 1, id, mode: 'functions' })}\n`, error => {
				if (error) this.rejectPending(error);
			});
		});
	}

	async stop(): Promise<void> {
		this.child?.stdin?.end();
		await this.exited;
	}

	private rejectPending(error: Error): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.reject(error);
	}

	private start(): void {
		const ready = Promise.withResolvers<void>();
		this.ready = ready.promise;
		const { command, args } = pythonCommand(['-B', 'build/desktop/live.py', '--protocol-prepared', '--serve']);
		const child = spawn(command, args, { cwd: this.root, env: this.environment, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
		this.child = child;
		let buffer = '';
		let initialized = false;
		const fail = (error: Error) => {
			ready.reject(error);
			this.rejectPending(error);
			child.stdin?.end();
		};
		child.stdin?.on('error', fail);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 65536) { fail(new Error('live build response exceeds byte budget')); return; }
			for (; ;) {
				const newline = buffer.indexOf('\n');
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const frame: unknown = JSON.parse(line);
					if (!frame || typeof frame !== 'object' || !('protocol_version' in frame) || frame.protocol_version !== 1 || !('id' in frame)) throw new Error('invalid live build response');
					if (!initialized) {
						if (frame.id !== null || !('result' in frame) || !frame.result || typeof frame.result !== 'object' || !('event' in frame.result) || frame.result.event !== 'ready') throw new Error('invalid live build ready event');
						initialized = true;
						ready.resolve();
						continue;
					}
					if (!this.pending || frame.id !== this.pending.id) throw new Error('mismatched live build response');
					if ('error' in frame) { this.rejectPending(new Error(String(frame.error))); continue; }
					if (!('result' in frame) || !frame.result || typeof frame.result !== 'object' || !('kind' in frame.result) || !['function', 'module'].includes(String(frame.result.kind))) throw new Error('invalid live build result');
					const pending = this.pending;
					this.pending = undefined;
					pending.resolve();
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
					return;
				}
			}
		});
		this.exited = new Promise<void>(resolveExit => {
			child.once('error', fail);
			child.once('close', (code, signal) => {
				fail(new Error(`live build session closed (${signal ?? code ?? 'unknown'})`));
				if (this.child === child) this.child = undefined;
				resolveExit();
			});
		});
	}
}
