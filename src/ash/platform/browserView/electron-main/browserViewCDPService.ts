import { addAbortListener } from 'node:events';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { promiseWithResolvers, raceCancellationError } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import type { BrowserCDPOperation, IBrowserUploadFile } from '../common/browserView.js';
import type { CDPEvent, CDPResponse } from '../common/cdp/types.js';
import type { BrowserView } from './browserView.js';
import { BrowserViewGroup } from './browserViewGroup.js';

const MAX_EVENT_BYTES = 512 * 1024;

/** Owns one explicitly granted protocol connection per Thread, independent of Playwright. */
export class BrowserViewCDPService extends Disposable {
	private readonly connections = this._register(new DisposableMap<string, BrowserCDPConnection>());
	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { super(); }

	public async perform(threadId: string, page: BrowserView, operation: BrowserCDPOperation, signal: AbortSignal, networkToken: string | null, uploads: readonly IBrowserUploadFile[] = []): Promise<{ output: string; createdTargetId?: string; }> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		if (operation.type === 'close') {
			const connection = this.connections.deleteAndLeak(threadId);
			await connection?.close();
			return { output: JSON.stringify({ closed: true }) };
		}
		if (operation.type === 'readEvents') {
			return { output: JSON.stringify(this.connections.get(threadId)?.readEvents() ?? { events: [], dropped: 0 }) };
		}
		let connection = this.connections.get(threadId);
		if (connection?.isDisposed) { this.connections.deleteAndDispose(threadId); connection = undefined; }
		if (!connection) {
			if (this.connections.size >= 64) { throw new Error('BrowserCDPCapacityExceeded'); }
			connection = this.instantiation.createInstance(BrowserCDPConnection, threadId);
			this.connections.set(threadId, connection);
		}
		return connection.command(page, operation, signal, networkToken, uploads);
	}

	public async disposeSession(threadId: string): Promise<void> { await this.connections.deleteAndLeak(threadId)?.close(); }
	public async reset(): Promise<void> {
		await Promise.all([...this.connections.keys()].map(threadId => this.disposeSession(threadId)));
	}
}

class BrowserCDPConnection extends Disposable {
	private readonly group: BrowserViewGroup;
	private readonly ready: Promise<void>;
	private readonly cancellation = new AbortController();
	private readonly pending = new Map<number, { resolve: (response: CDPResponse) => void; reject: (error: Error) => void; }>();
	private readonly roots = new Map<string, string>();
	private readonly pendingRoots = new Map<string, Promise<string>>();
	private readonly events: Array<{ event: CDPEvent; bytes: number; }> = [];
	private bytes = 0;
	private dropped = 0;
	private sequence = 0;

	constructor(threadId: string, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.group = this._register(instantiation.createInstance(BrowserViewGroup, { sandboxSessionId: threadId, agentOnly: true }, () => { }));
		this._register(this.group.onDidDestroy(() => this.dispose()));
		this._register(this.group.onCDPMessage(message => {
			if ('id' in message) { this.pending.get(message.id)?.resolve(message); return; }
			if (message.method === 'Target.detachedFromTarget' && isRecord(message.params)) {
				for (const [page, session] of this.roots) { if (session === message.params.sessionId) { this.roots.delete(page); } }
			}
			const bytes = Buffer.byteLength(JSON.stringify(message));
			if (bytes > MAX_EVENT_BYTES) { this.dropped++; return; }
			while (this.events.length >= 256 || this.bytes + bytes > MAX_EVENT_BYTES) {
				this.bytes -= this.events.shift()!.bytes;
				this.dropped++;
			}
			this.events.push({ event: message, bytes });
			this.bytes += bytes;
		}));
		this.ready = this.group.initialize();
		void this.ready.catch(() => this.dispose());
	}

	public async command(page: BrowserView, operation: Extract<BrowserCDPOperation, { type: 'command'; }>, requestSignal: AbortSignal, networkToken: string | null, uploads: readonly IBrowserUploadFile[]): Promise<{ output: string; createdTargetId?: string; }> {
		const signal = AbortSignal.any([requestSignal, this.cancellation.signal]);
		await raceCancellationError(this.ready, signal, 'BrowserRequestCancelled');
		signal.throwIfAborted();
		let sessionId = operation.sessionId;
		if (!sessionId && !operation.method.startsWith('Browser.') && !operation.method.startsWith('Target.')) {
			sessionId = await this.pageSession(page, signal, networkToken);
		}
		using cancellation = addAbortListener(signal, () => {
			if (this.group.isDisposed) { return; }
			// These controls bypass the page queue and release an evaluation or paused debugger.
			for (const method of ['Runtime.terminateExecution', 'Debugger.resume']) {
				void this.group.sendCDPMessage({ id: ++this.sequence, method, sessionId }).catch(() => { });
			}
		});
		const response = await this.request(operation.method, operation.params, sessionId, signal, networkToken, uploads);
		const output = JSON.stringify(response);
		if (Buffer.byteLength(output) > 1024 * 1024) { throw new Error('BrowserCDPResultTooLarge'); }
		return {
			output,
			...(operation.method === 'Target.createTarget' && !response.error && isRecord(response.result) && typeof response.result.browserViewId === 'string'
				? { createdTargetId: response.result.browserViewId } : {}),
		};
	}

	private async pageSession(page: BrowserView, signal: AbortSignal, networkToken: string | null): Promise<string> {
		const existing = this.roots.get(page.id);
		if (existing) { return existing; }
		let pending = this.pendingRoots.get(page.id);
		if (!pending) {
			pending = (async () => {
				const attached = await this.request('Target.attachToTarget', { targetId: await page.debugger.getTargetId(), flatten: true }, undefined, signal, networkToken);
				if (attached.error || !isRecord(attached.result) || typeof attached.result.sessionId !== 'string') { throw new Error('BrowserCDPAttachmentFailed'); }
				signal.throwIfAborted();
				this.roots.set(page.id, attached.result.sessionId);
				return attached.result.sessionId;
			})().finally(() => this.pendingRoots.delete(page.id));
			this.pendingRoots.set(page.id, pending);
		}
		return raceCancellationError(pending, signal, 'BrowserRequestCancelled');
	}

	private async request(method: string, params: Record<string, unknown>, sessionId: string | undefined, signal: AbortSignal, networkToken: string | null, uploads: readonly IBrowserUploadFile[] = []): Promise<CDPResponse> {
		this.assertNotDisposed();
		if (this.pending.size >= 128) { throw new Error('BrowserCDPCapacityExceeded'); }
		const id = ++this.sequence;
		const response = promiseWithResolvers<CDPResponse>();
		this.pending.set(id, response);
		try {
			void this.group.sendCDPMessage({ id, method, params, sessionId }, { signal, networkToken, uploads }).catch(response.reject);
			return await raceCancellationError(response.promise, signal, 'BrowserRequestCancelled');
		} finally { this.pending.delete(id); }
	}

	public readEvents(): { events: CDPEvent[]; dropped: number; } {
		this.assertNotDisposed();
		const result = { events: this.events.splice(0).map(entry => entry.event), dropped: this.dropped };
		this.bytes = 0;
		this.dropped = 0;
		return result;
	}
	public async close(): Promise<void> { this.dispose(); await this.group.close(); }
	protected override disposeCore(): void {
		this.cancellation.abort();
		for (const request of this.pending.values()) { request.reject(new Error('BrowserCDPConnectionClosed')); }
		this.pending.clear();
		this.events.length = 0;
		this.roots.clear();
		this.pendingRoots.clear();
		super.disposeCore();
	}
}
