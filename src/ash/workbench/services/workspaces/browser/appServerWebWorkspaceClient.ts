import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import type { IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { decodeWebListenInfo, decodeWebWorkspaceListResult, decodeWebWorkspaceState } from '../../../../../../.build/protocol/typescript/WebProtocolDecoder.js';
import type { WebWorkspaceListRequest, WebWorkspaceOpenRequest, WebWorkspaceState, WebWorkspaceUpdateRequest } from '../../../../../../.build/protocol/typescript/index.js';

/** Host-neutral directory selection; generated transport types stay in this adapter. */
export interface IWebWorkspaceDirectoryList {
	readonly path: string;
	readonly parent: string | null;
	readonly directories: readonly { readonly name: string; readonly path: string; }[];
}

export interface IWebWorkspaceTransition {
	readonly workspace: IWorkspace;
	complete(accepted: boolean): Promise<void>;
}

export interface IWebWorkspaceClient {
	getInitialWorkspace?(): IWorkspace | undefined;
	/** The authenticated server host publishes directory proofs before the UI accepts them. */
	updateWorkspace?(configuration: URI, folders: readonly { readonly path: string; readonly name: string; }[]): Promise<IWebWorkspaceTransition>;
	list(path: string): Promise<IWebWorkspaceDirectoryList>;
	authorize(path: string): Promise<() => void>;
}

/** Authenticated browser control requests stay outside the workspace-bound JSONL connection. */
export class AppServerWebWorkspaceClient implements IWebWorkspaceClient {
	constructor(
		private readonly endpoint: URL,
		private readonly token: string,
		private readonly targetWindow: Window,
		private initialWorkspace?: WebWorkspaceState,
	) { }

	getInitialWorkspace(): IWorkspace | undefined { return this.initialWorkspace && workspaceFromState(this.initialWorkspace); }

	private get transactionKey(): string { return `ash.appServer.workspaceTransaction:${this.endpoint.origin}`; }

	/** A page reload settles the last explicitly recorded UI outcome before restoring editors. */
	async recoverPending(): Promise<void> {
		const value = this.targetWindow.sessionStorage.getItem(this.transactionKey);
		if (!value) return;
		const pending: unknown = JSON.parse(value);
		if (!pending || typeof pending !== 'object' || !('transaction' in pending) || typeof pending.transaction !== 'string' || !('accepted' in pending) || typeof pending.accepted !== 'boolean') throw new Error(localize('workspace.invalidTransaction', 'The saved workspace transition could not be recovered.'));
		try {
			const request: WebWorkspaceUpdateRequest = { operation: 'finish', transaction: pending.transaction, accepted: pending.accepted };
			this.initialWorkspace = decodeWebWorkspaceState(await this.request('update', request));
		} catch (error) {
			// A restarted listener has no surviving grant transaction; its authenticated
			// session metadata is the only authority for restoration in that case.
			if (!(error instanceof WebWorkspaceHttpError) || error.status !== 400) throw error;
		}
		this.targetWindow.sessionStorage.removeItem(this.transactionKey);
	}

	async updateWorkspace(configuration: URI, folders: readonly { readonly path: string; readonly name: string; }[]): Promise<IWebWorkspaceTransition> {
		await this.recoverPending();
		const transaction = crypto.randomUUID();
		this.targetWindow.sessionStorage.setItem(this.transactionKey, JSON.stringify({ transaction, accepted: false }));
		const request: WebWorkspaceUpdateRequest = { operation: 'apply', transaction, configuration: configuration.toString(), folders: [...folders], approved: true };
		let workspace: IWorkspace;
		try { workspace = workspaceFromState(decodeWebWorkspaceState(await this.request('update', request))); }
		catch (error) {
			// The caller knows the operation identity even if its response was lost.
			// Recovering this explicit transaction does not replay a workspace mutation.
			await this.recoverPending();
			throw error;
		}
		return {
			workspace, complete: async accepted => {
				this.targetWindow.sessionStorage.setItem(this.transactionKey, JSON.stringify({ transaction, accepted }));
				const finish: WebWorkspaceUpdateRequest = { operation: 'finish', transaction, accepted };
				try { decodeWebWorkspaceState(await this.request('update', finish)); }
				catch { decodeWebWorkspaceState(await this.request('update', finish)); }
				this.targetWindow.sessionStorage.removeItem(this.transactionKey);
			}
		};
	}

	async list(path: string): Promise<IWebWorkspaceDirectoryList> {
		const request: WebWorkspaceListRequest = { path };
		return decodeWebWorkspaceListResult(await this.request('list', request));
	}

	async authorize(path: string): Promise<() => void> {
		const request: WebWorkspaceOpenRequest = { path, approved: true };
		const listen = decodeWebListenInfo(await this.request('open', request));
		const destination = this.targetWindow.location.origin === this.endpoint.origin
			? new URL(this.targetWindow.location.pathname + this.targetWindow.location.search, listen.endpoint)
			: new URL(this.targetWindow.location.href);
		const hash = new URLSearchParams({ 'ash-endpoint': listen.endpoint, 'ash-ticket': listen.ticket });
		destination.hash = hash.toString();
		return () => this.targetWindow.location.assign(destination.href);
	}

	private async request(operation: 'list' | 'open' | 'update', payload: object): Promise<unknown> {
		const response = await fetch(new URL(`/ash/workspace/${operation}`, this.endpoint), {
			method: 'POST', credentials: 'omit', cache: 'no-store', signal: operation === 'list' ? AbortSignal.timeout(30_000) : undefined,
			headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			const detail = await response.text();
			const message = response.status === 403 ? localize('workspace.serverPermissionDenied', 'The server did not authorize this workspace change.')
				: response.status === 409 ? localize('workspace.serverTransitionBusy', 'Another workspace change is still awaiting completion.')
					: response.status === 401 || response.status === 410 ? localize('workspace.serverSessionClosed', 'The workspace session closed. Reopen the authenticated server link.')
						: localize('workspace.serverRequestFailed', 'The server could not complete the workspace request.');
			throw new WebWorkspaceHttpError(response.status, message, detail);
		}
		return response.json();
	}
}

function workspaceFromState(state: WebWorkspaceState): IWorkspace {
	const configuration = state.configuration ? URI.parse(state.configuration) : undefined;
	return {
		id: state.id,
		...(configuration ? { configuration, name: basename(configuration).replace(/\.(ash|code)-workspace$/i, '') } : {}),
		folders: state.folders.map((folder, index) => ({ id: folder.id, uri: URI.file(folder.path), name: folder.name ?? basename(URI.file(folder.path)), index })),
	};
}

class WebWorkspaceHttpError extends Error {
	constructor(readonly status: number, message: string, detail: string) { super(message, { cause: new Error(detail) }); }
}
