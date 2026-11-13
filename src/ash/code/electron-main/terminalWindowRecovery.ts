import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IpcRoute } from '../../platform/ipc/electron-main/trustedIpcRouter.js';
import { BaseSecretStorageService } from '../../platform/secrets/common/secrets.js';
import { TerminalStorageKeys } from '../../workbench/contrib/terminal/common/terminalStorageKeys.js';

interface TerminalLifetime {
	readonly resources: DisposableStore;
	readonly routes: readonly IpcRoute<unknown, string>[];
}

/** Window-local terminal capabilities; only its explicitly opened replacement may inherit them. */
export class TerminalWindowRecovery extends Disposable {
	public readonly secrets = this._register(new BaseSecretStorageService());
	private readonly lifetime: TerminalLifetime;
	private reopening: Promise<void> | undefined;

	constructor(private readonly createLifetime: (resources: DisposableStore) => readonly IpcRoute<unknown, string>[], borrowedLifetime?: TerminalLifetime) {
		super();
		if (borrowedLifetime) this.lifetime = borrowedLifetime;
		else {
			const resources = this._register(new DisposableStore());
			this.lifetime = { resources, routes: createLifetime(resources) };
		}
	}

	public get routes(): readonly IpcRoute<unknown, string>[] { return this.lifetime.routes; }

	/** Keep source ownership until the replacement loads; a failed open can retry safely. */
	public reopen(open: (replacement: TerminalWindowRecovery) => Promise<void>): Promise<void> {
		if (this.reopening) return this.reopening;
		const operation = this.openReplacement(open);
		this.reopening = operation;
		void operation.catch(() => { if (this.reopening === operation) this.reopening = undefined; });
		return operation;
	}

	private async openReplacement(open: (replacement: TerminalWindowRecovery) => Promise<void>): Promise<void> {
		this.assertNotDisposed();
		const credentials = await this.secrets.get(TerminalStorageKeys.Reload);
		// No checkpoint means no recovery promise. In particular, do not share
		// arbitrary window secrets or revive another window in the same workspace.
		const replacement = new TerminalWindowRecovery(this.createLifetime, credentials ? this.lifetime : undefined);
		try {
			if (credentials) await replacement.secrets.set(TerminalStorageKeys.Reload, credentials);
			await open(replacement);
			if (this.isDisposed || replacement.isDisposed) throw new Error('Terminal recovery window closed during startup');
			if (credentials) {
				// Both routes use the original opaque lifetime while opening. Once the
				// replacement has loaded, its resource scope owns the pipe, so destroying
				// the source disconnects its PTY client without killing the process.
				this._store.delete(this.lifetime.resources);
				replacement._store.add(this.lifetime.resources);
				await this.secrets.delete(TerminalStorageKeys.Reload);
			}
		} catch (error) {
			replacement.dispose();
			throw error;
		}
	}
}
