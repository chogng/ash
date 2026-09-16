import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron/main';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import type { DirGrant, DirPermission } from '../../dirPermissions/common/dirPermissionsService.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';

/** Routes window-owned workspace operations to the renderer that owns the backend connection. */
export class RendererWorkspaceHost extends Disposable {
	private pending: { nonce: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;

	constructor(private readonly renderer: WebContents) { super(); }

	public readPermissions(path: string): Promise<readonly DirPermission[] | undefined> { return this.call('readPermissions', { path }) as Promise<readonly DirPermission[] | undefined>; }
	public createGrant(path: string, permissions: readonly DirPermission[]): Promise<DirGrant> { return this.call('createGrant', { path, permissions }) as Promise<DirGrant>; }
	public async switchWorkspace(path: string, grant: DirGrant): Promise<void> { await this.call('switchWorkspace', { path, grant }); }
	public async setFolders(folders: readonly { id: string; path: string; grant: DirGrant }[]): Promise<void> { await this.call('setFolders', { folders }); }

	public routes(): readonly IpcRoute<unknown, unknown>[] {
		return [{ channel: 'ash:workspace:completed', validate: value => {
			if (!isRecord(value) || typeof value.nonce !== 'string' || (value.error !== undefined && typeof value.error !== 'string')) { throw new Error('Invalid workspace completion'); }
			return value;
		}, invoke: value => {
			const reply = value as { nonce: string; result?: unknown; error?: string; failure?: unknown };
			if (this.pending?.nonce !== reply.nonce) { return; }
			const pending = this.pending;
			this.pending = undefined;
			clearTimeout(pending.timer);
			if (reply.failure === 'EnvCwdSetBusy' || reply.failure === 'EnvCwdSetUnavailable' || reply.failure === 'MethodNotFound') { pending.reject(new AppServerRemoteError(-32000, reply.error ?? reply.failure, { kind: reply.failure })); }
			else if (reply.error) { pending.reject(new Error(reply.error)); }
			else { pending.resolve(reply.result); }
		} }];
	}

	protected override disposeCore(): void {
		if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Workspace window closed')); this.pending = undefined; }
		super.disposeCore();
	}

	private call(operation: string, params: object): Promise<unknown> {
		this.assertNotDisposed();
		if (this.pending) { return Promise.reject(new Error('Workspace operation already in progress')); }
		return new Promise((resolve, reject) => {
			const nonce = randomUUID();
			const timer = setTimeout(() => { this.pending = undefined; reject(new Error('Workspace renderer timed out')); }, 30_000);
			this.pending = { nonce, resolve, reject, timer };
			this.renderer.send('ash:workspace:operation', { nonce, operation, params });
		});
	}
}
