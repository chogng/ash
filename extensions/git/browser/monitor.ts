import { backend } from 'ash';
import { Disposable, Emitter, toDisposable, URI, type Event } from '../../../sdk/browser/index.js';
import type { ServerNotification } from '../../../.build/protocol/typescript/index.js';
export interface WorkspaceFolder { readonly id: string; readonly name: string; readonly index: number; readonly uri: URI; }
export interface WorkspaceFacts { getWorkspace(): { folders: readonly WorkspaceFolder[]; }; readonly onDidChangeWorkspace: Event<{ workspace: { folders: readonly WorkspaceFolder[]; }; }>; }
export interface BackendConnection { getConnectionState(): Promise<string>; onConnectionState(listener: (state: string) => void): { dispose(): void; }; }
export interface BackendEvents { subscribe(listener: (event: ServerNotification) => void): { dispose(): void; }; }
interface State { sequence: number; generation: number; reset: boolean; connection: string; events: ServerNotification[]; folders: { id: string; name: string; uri: string; }[]; }
export class GitBackendMonitor extends Disposable {
	private readonly events = this._register(new Emitter<ServerNotification>());
	private readonly connectionChanged = this._register(new Emitter<string>());
	private readonly workspaceChanged = this._register(new Emitter<{ workspace: { folders: readonly WorkspaceFolder[]; }; }>());
	private state: State | undefined;
	private folders: readonly WorkspaceFolder[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	public readonly connection: BackendConnection = { getConnectionState: async () => this.state?.connection ?? 'stopped', onConnectionState: listener => this.connectionChanged.event(listener) };
	public readonly notifications: BackendEvents = { subscribe: listener => this.events.event(listener) };
	public readonly workspace: WorkspaceFacts = { getWorkspace: () => ({ folders: this.folders }), onDidChangeWorkspace: this.workspaceChanged.event };
	constructor(private readonly reportError: (error: unknown) => void) { super(); this._register(toDisposable(() => clearTimeout(this.timer))); }
	public async start(): Promise<void> { await this.poll(); }
	private async poll(): Promise<void> {
		try {
			const state = await backend.state<State>('git.repository', this.state?.sequence ?? 0);
			if (this.isDisposed) { return; }
			const foldersChanged = JSON.stringify(this.state?.folders) !== JSON.stringify(state.folders);
			const connectionChanged = this.state?.connection !== state.connection || this.state?.generation !== state.generation || state.reset;
			this.state = state;
			if (foldersChanged) { this.folders = state.folders.map((folder, index) => ({ ...folder, index, uri: URI.parse(folder.uri) })); this.workspaceChanged.fire({ workspace: { folders: this.folders } }); }
			if (connectionChanged) { this.connectionChanged.fire(state.connection); }
			for (const event of state.events) { this.events.fire(event); }
		} catch (error) { if (!this.isDisposed) { this.reportError(error); } }
		if (!this.isDisposed) { this.timer = setTimeout(() => void this.poll(), 500); }
	}
}
