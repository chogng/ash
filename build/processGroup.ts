import { spawn, type ChildProcess } from 'node:child_process';

export type ProcessOutput = (stream: 'stdout' | 'stderr', data: string) => void;
type Request = { readonly id: number; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly capture: boolean; readonly stdin: 'ignore' | 'inherit'; readonly stream: boolean; };
type Result = { readonly code: number; readonly output: string; };

/** A live group leader prevents its process-group ID being reused before cleanup. */
export class OwnedProcessGroup {
	private readonly leader: ChildProcess;
	private readonly exited: Promise<void>;
	private readonly pending = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void; onOutput?: ProcessOutput; }>();
	private sequence = 0;
	private closing = false;
	private signal: NodeJS.Signals = 'SIGKILL';
	constructor() {
		this.leader = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
			detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
		});
		this.leader.on('message', (message: { id?: number; result?: Result; error?: string; stream?: 'stdout' | 'stderr'; data?: string; }) => {
			if (typeof message?.id !== 'number') return;
			const request = this.pending.get(message.id);
			if (!request) return;
			if (message.stream && typeof message.data === 'string') { request.onOutput?.(message.stream, message.data); return; }
			this.pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error));
			else if (message.result) request.resolve(message.result);
		});
		this.exited = new Promise(resolve => {
			this.leader.once('error', error => { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); resolve(); });
			this.leader.once('exit', (code, signal) => {
				for (const request of this.pending.values()) {
					if (this.closing) request.resolve({ code: this.signal === 'SIGINT' ? 130 : this.signal === 'SIGTERM' ? 143 : 1, output: '' });
					else request.reject(new Error(`Process group leader exited unexpectedly (${code ?? signal})`));
				}
				this.pending.clear(); resolve();
			});
		});
	}
	command(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, capture: boolean, stdin: 'ignore' | 'inherit', onOutput?: ProcessOutput): Promise<Result> {
		if (this.closing || !this.leader.connected) return Promise.reject(new Error('Process group is closed'));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onOutput });
			this.leader.send({ id, command, args, cwd, env, capture, stdin, stream: onOutput !== undefined } satisfies Request, error => {
				if (error && this.pending.delete(id)) reject(error);
			});
		});
	}
	async stop(signal: NodeJS.Signals, graceMs: number): Promise<void> {
		this.signal = signal;
		if (this.leader.connected) this.leader.send({ stop: signal }, () => { });
		const deadline = Date.now() + graceMs;
		while (this.pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
		await this.close();
	}
	async close(): Promise<void> {
		this.closing = true;
		// Only signal a group while its held leader is still alive. Never rediscover
		// a numeric PID from a prior run or signal the caller's inherited group.
		if (this.leader.pid && this.leader.exitCode === null && this.leader.signalCode === null) {
			try { process.kill(-this.leader.pid, 'SIGKILL'); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
		}
		await this.exited;
	}
}

// Keep the worker self-contained: scenario runners bundle their imports into a
// different output directory, and must not execute that bundle as a worker.
const workerSource = String.raw`
import { spawn } from 'node:child_process';
const children = new Map();
const reply = message => { if (process.connected) process.send(message, () => {}); };
const forward = signal => {
  for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
process.once('disconnect', () => { process.kill(-process.pid, 'SIGKILL'); });
process.on('message', message => {
  if ('stop' in message) { forward(message.stop); return; }
  const { id, command, args, cwd, env, capture, stdin, stream } = message;
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: false, stdio: [capture ? 'ignore' : stdin, capture || stream ? 'pipe' : 'inherit', stream ? 'pipe' : 'inherit'], windowsHide: true });
  } catch (error) { reply({ id, error: error.message }); return; }
  children.set(id, child);
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', data => { if (capture) output += data; if (stream) reply({ id, stream: 'stdout', data }); });
  child.stderr?.on('data', data => { reply({ id, stream: 'stderr', data }); });
  child.once('error', error => {
    children.delete(id);
    reply({ id, error: error.message });
  });
  child.once(capture || stream ? 'close' : 'exit', (code, signal) => {
    if (!children.delete(id)) return;
    reply({ id, result: { code: signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code ?? 1, output } });
  });
});
`;
