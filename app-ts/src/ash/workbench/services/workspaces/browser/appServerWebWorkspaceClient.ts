import { decodeWebListenInfo, decodeWebWorkspaceListResult } from '../../../../platform/app-server/common/generated/WebProtocolDecoder.js';
import type { WebWorkspaceListRequest, WebWorkspaceOpenRequest } from '../../../../platform/app-server/common/generated/index.js';
import type { IWebWorkspaceClient, IWebWorkspaceDirectoryList } from './workspaceOpenService.js';

/** Authenticated browser control requests stay outside the workspace-bound JSONL connection. */
export class AppServerWebWorkspaceClient implements IWebWorkspaceClient {
	constructor(
		private readonly endpoint: URL,
		private readonly token: string,
		private readonly targetWindow: Window,
	) {}

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

	private async request(operation: 'list' | 'open', payload: object): Promise<unknown> {
		const response = await fetch(new URL(`/ash/workspace/${operation}`, this.endpoint), {
			method: 'POST', credentials: 'omit', cache: 'no-store', signal: operation === 'list' ? AbortSignal.timeout(30_000) : undefined,
			headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	}
}
