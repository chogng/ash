import { localize } from '../../../nls.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { TERMINAL_WINDOW_LIFETIME_CHANNEL } from '../common/terminal.js';

interface TerminalOwnerLaunch {
	readonly executable: string;
	readonly profile: string;
	readonly environment: Readonly<Record<string, string>>;
}

/** Keeps a window's opaque Rust lifetime connection alive across renderer/backend reloads. */
export class TerminalWindowLifetimeHost extends Disposable {
	private child: ChildProcess | undefined;
	private pending: Promise<string> | undefined;

	constructor(private readonly launch: () => Promise<TerminalOwnerLaunch>) {
		super();
		this._register(toDisposable(() => {
			// Closing the pipe also works when the business backend is unavailable.
			// Main process death closes it in the OS, without a JS shutdown handler.
			this.child?.stdin?.destroy();
			this.child = undefined;
		}));
	}

	routes(): IpcRoute<unknown, string>[] {
		return [{
			channel: TERMINAL_WINDOW_LIFETIME_CHANNEL,
			validate: value => { if (value !== undefined) throw new TypeError('Terminal lifetime accepts no arguments'); return undefined; },
			invoke: () => this.getToken(),
		}];
	}

	private getToken(): Promise<string> {
		if (this.isDisposed) return Promise.reject(new Error(localize('terminal.windowLifetime.closed', 'Terminal window is closed')));
		if (!this.pending) {
			const pending = this.start();
			this.pending = pending;
			void pending.catch(() => { if (this.pending === pending) this.pending = undefined; });
		}
		return this.pending;
	}

	private async start(): Promise<string> {
		const launch = await this.launch();
		if (this.isDisposed) throw new Error(localize('terminal.windowLifetime.closed', 'Terminal window is closed'));
		const token = randomBytes(32).toString('hex');
		const child = spawn(launch.executable, ['--terminal-owner', launch.profile], {
			env: launch.environment, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
		});
		this.child = child;
		child.once('exit', () => {
			if (this.child === child) { this.child = undefined; this.pending = undefined; }
		});
		try {
			await new Promise<void>((resolve, reject) => {
				let response = '';
				const finish = (error?: Error): void => {
					clearTimeout(timer);
					child.stdout!.removeListener('data', onData);
					child.removeListener('error', onError);
					child.removeListener('exit', onExit);
					if (error) reject(error); else resolve();
				};
				const onError = (error: Error): void => finish(error);
				const onExit = (): void => finish(new Error(localize('terminal.windowLifetime.registrationExited', 'Terminal lifetime process exited before registration')));
				const onData = (data: Buffer): void => {
					response += data.toString('utf8');
					if (response === 'ready\n') finish();
					else if (response.length > 16 || response.includes('\n')) finish(new Error(localize('terminal.windowLifetime.registrationInvalid', 'Invalid terminal lifetime registration')));
				};
				const timer = setTimeout(() => finish(new Error(localize('terminal.windowLifetime.registrationTimedOut', 'Terminal lifetime registration timed out'))), 10_000);
				child.stdout!.on('data', onData);
				child.once('error', onError);
				child.once('exit', onExit);
				child.stdin!.on('error', () => { /* Exit/error owns the registration result. */ });
				// Never put a lifetime credential in argv, environment, or logs.
				child.stdin!.write(`${token}\n`);
			});
			if (this.isDisposed || this.child !== child) throw new Error(localize('terminal.windowLifetime.closed', 'Terminal window is closed'));
			return token;
		} catch (error) {
			child.stdin?.destroy();
			child.kill();
			throw error;
		}
	}
}
