import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { BrowserViewAction, IBrowserViewObservation, IBrowserViewObservationOptions } from '../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { decodeAppServerServerRequestResult } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';

/** Main retains authorization and page ordering before dispatching to the shared process. */
class PlaywrightChannelClient extends AbstractDisposable implements IPlaywrightService {
	private readonly channel: IChannel;
	private readonly operations = new Map<string, string>();
	private readonly sessions = new Set<string>();
	private readonly retiringSessions = new Map<string, Promise<void>>();

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this.channel = mainProcessService.getChannel('browserHost');
	}

	public async getObservation(operationId: string, sessionId: string, pageId: string, options: IBrowserViewObservationOptions, networkToken?: string | null): Promise<IBrowserViewObservation> {
		const result = await this.run(operationId, sessionId, 'observe', {
			threadId: sessionId,
			targetId: pageId,
			includeAccessibilityTree: options.includeAccessibilityTree,
			includeDomSnapshot: options.includeDomSnapshot,
			includeScreenshot: options.includeScreenshot,
			networkToken: networkToken ?? null,
		});
		const { screenshot, ...observation } = decodeAppServerServerRequestResult('browser/observe', result);
		if (!screenshot) { return observation; }
		if (screenshot.mimeType !== 'image/png') { throw new TypeError('Invalid browser screenshot MIME type'); }
		return { ...observation, screenshot: { ...screenshot, mimeType: 'image/png' } };
	}

	public async performAction(operationId: string, sessionId: string, pageId: string, action: BrowserViewAction, networkToken?: string | null): Promise<void> {
		const result = await this.run(operationId, sessionId, 'perform', { threadId: sessionId, action: { ...action, targetId: pageId }, networkToken: networkToken ?? null });
		decodeAppServerServerRequestResult('browser/perform', result);
	}

	public cancelOperation(operationId: string): Promise<void> {
		return this.channel.call('cancel', { id: operationId });
	}

	public disposeSession(sessionId: string): Promise<void> {
		let pending = this.retiringSessions.get(sessionId);
		if (!pending) {
			pending = (async () => {
				const cancellations = [...this.operations].filter(([, owner]) => owner === sessionId).map(([id]) => this.cancelOperation(id));
				// The channel preserves send order. Dispatch cleanup before synchronous scope disposal closes it.
				const release = this.channel.call('disposeSession', { threadId: sessionId });
				await Promise.all([...cancellations, release]);
				this.sessions.delete(sessionId);
			})().finally(() => this.retiringSessions.delete(sessionId));
			this.retiringSessions.set(sessionId, pending);
		}
		return pending;
	}

	private async run(operationId: string, sessionId: string, command: string, params: unknown): Promise<unknown> {
		this.assertNotDisposed();
		if (this.retiringSessions.has(sessionId)) { throw new Error('Browser session is being released'); }
		if (this.operations.has(operationId)) { throw new Error('Duplicate browser operation'); }
		this.operations.set(operationId, sessionId);
		this.sessions.add(sessionId);
		try { return await this.channel.call(command, { id: operationId, params }); }
		finally { this.operations.delete(operationId); }
	}

	protected override disposeCore(): void {
		// Cancel queued page operations before retiring the connections they would otherwise recreate.
		for (const id of this.sessions) {
			// Main also cleans up with the window; an acknowledgement can arrive after the IPC peer closes.
			void this.disposeSession(id).catch(() => { });
		}
		this.operations.clear();
		this.sessions.clear();
	}
}

registerSingleton(IPlaywrightService, PlaywrightChannelClient, InstantiationType.Delayed);
