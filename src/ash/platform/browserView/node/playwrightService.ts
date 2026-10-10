import { chromium, type Browser, type CDPSession, type ConnectOverCDPTransport, type Page } from 'playwright-core';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { promiseWithResolvers, raceCancellationError } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import { IBrowserViewGroupService } from '../common/browserViewGroup.js';
import type { CDPRequest } from '../common/cdp/types.js';
import type { IPlaywrightService } from '../common/playwrightService.js';
import type { BrowserViewAction, IBrowserViewObservation, IBrowserViewObservationOptions } from '../common/browserView.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';

interface ConnectedPage { readonly page: Page; readonly cdp: CDPSession; readonly id: string; }
const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

class Connection extends Disposable {
	private readonly pages = new WeakMap<Page, Promise<ConnectedPage>>();
	private browserConnection: Promise<Browser> | undefined;
	private get browser(): Promise<Browser> { return this.browserConnection ??= this.connect(); }
	constructor(private readonly sessionId: string, @IBrowserViewGroupService private readonly groups: IBrowserViewGroupService) {
		super();
		this._register(toDisposable(() => { void this.browserConnection?.then(browser => browser.close()).catch(() => { }); }));
	}
	private async connect(): Promise<Browser> {
		const groupId = await this.groups.createGroup({ sandboxSessionId: this.sessionId });
		if (this.isDisposed) { await this.groups.destroyGroup(groupId); throw new Error('BrowserCapabilityUnavailable'); }
		const resources = this._register(new DisposableStore());
		let closed = false;
		const transport: ConnectOverCDPTransport = {
			send: message => {
				if (!isRecord(message) || typeof message.id !== 'number' || typeof message.method !== 'string') { throw new TypeError('Invalid Playwright CDP request'); }
				void this.groups.sendCDPMessage(groupId, message as unknown as CDPRequest).catch(error => {
					transport.onmessage?.({ id: message.id, sessionId: message.sessionId, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
				});
			},
			close: () => {
				if (closed) { return; }
				closed = true;
				transport.onclose?.();
				resources.dispose();
				void this.groups.destroyGroup(groupId).catch(() => { });
			},
		};
		resources.add(this.groups.onDynamicCDPMessage(groupId)(message => transport.onmessage?.(message)));
		resources.add(this.groups.onDynamicDidDestroy(groupId)(() => { closed = true; transport.onclose?.(); resources.dispose(); }));
		resources.add(toDisposable(() => transport.close()));
		try {
			const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 30_000 });
			if (this.isDisposed) { await browser.close(); throw new Error('BrowserCapabilityUnavailable'); }
			return browser;
		} catch (error) { resources.dispose(); throw error; }
	}
	private identify(page: Page): Promise<ConnectedPage> {
		let connection = this.pages.get(page);
		if (!connection) {
			connection = (async () => {
				const cdp = await page.context().newCDPSession(page);
				const { targetInfo } = await cdp.send('Target.getTargetInfo');
				const viewId = (targetInfo as typeof targetInfo & { browserViewId: unknown; }).browserViewId;
				if (typeof viewId !== 'string') { throw new Error('BrowserCDPIdentityUnavailable'); }
				page.once('close', () => { void cdp.detach().catch(() => { }); });
				return { page, cdp, id: viewId };
			})();
			this.pages.set(page, connection);
		}
		return connection;
	}
	public async findPage(id: string, signal: AbortSignal): Promise<ConnectedPage> {
		const browser = await raceCancellationError(this.browser, signal, 'BrowserRequestCancelled');
		const found = promiseWithResolvers<ConnectedPage>();
		const contexts = browser.contexts();
		const arrived = (page: Page): void => {
			void this.identify(page).then(candidate => { if (candidate.id === id) { found.resolve(candidate); } }, error => found.reject(error));
		};
		for (const context of contexts) { context.on('page', arrived); }
		try {
			for (const context of contexts) {
				for (const page of context.pages()) { if (!page.isClosed()) { arrived(page); } }
			}
			return await raceCancellationError(found.promise, signal, 'BrowserRequestCancelled');
		} finally { for (const context of contexts) { context.off('page', arrived); } }
	}
}

/** Playwright and element operations stay outside Main and renderer lifetimes. */
export class PlaywrightService extends Disposable implements IPlaywrightService {
	private readonly connections = this._register(new DisposableMap<string, Connection>());
	private readonly operations = new Map<string, { readonly sessionId: string; readonly cancellation: AbortController; }>();
	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) { super(); }
	public async getObservation(operationId: string, sessionId: string, pageId: string, options: IBrowserViewObservationOptions): Promise<IBrowserViewObservation> {
		return this.run(operationId, sessionId, pageId, async ({ page, cdp }, signal) => {
			await page.waitForLoadState('load'); signal.throwIfAborted();
			const accessibilityTree = options.includeAccessibilityTree ? boundedJson(await cdp.send('Accessibility.getFullAXTree')) : undefined;
			signal.throwIfAborted();
			const domSnapshot = options.includeDomSnapshot ? boundedJson(await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] })) : undefined;
			signal.throwIfAborted();
			const png = options.includeScreenshot ? await page.screenshot({ type: 'png' }) : undefined;
			signal.throwIfAborted();
			if (png && png.byteLength > MAX_SCREENSHOT_BYTES) { throw new Error('BrowserScreenshotTooLarge'); }
			return {
				targetId: pageId, url: page.url(), title: await page.title(), loading: false,
				...(accessibilityTree === undefined ? {} : { accessibilityTree }), ...(domSnapshot === undefined ? {} : { domSnapshot }),
				...(png === undefined ? {} : { screenshot: { mimeType: 'image/png' as const, dataBase64: png.toString('base64'), decodedLength: png.byteLength } })
			};
		});
	}
	public async performAction(operationId: string, sessionId: string, pageId: string, action: BrowserViewAction): Promise<void> {
		await this.run(operationId, sessionId, pageId, async ({ page, cdp }, signal) => {
			await page.waitForLoadState('load'); signal.throwIfAborted();
			switch (action.type) {
				case 'click': {
					const objectId = await resolveNode(cdp, action.target.nodeId);
					try {
						const location = await cdp.send('Runtime.callFunctionOn', {
							objectId,
							functionDeclaration: "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); const rect = this.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }", returnByValue: true
						});
						signal.throwIfAborted();
						const { x, y } = location.result.value as { x: number; y: number; };
						if (!Number.isFinite(x) || !Number.isFinite(y)) { throw new Error('BrowserNodeUnavailable'); }
						await page.mouse.click(x, y);
					} finally { await cdp.send('Runtime.releaseObject', { objectId }).catch(() => { }); }
					break;
				}
				case 'typeText':
					if (action.target.type === 'element') {
						const objectId = await resolveNode(cdp, action.target.target.nodeId);
						try {
							const focused = await cdp.send('Runtime.callFunctionOn', {
								objectId,
								functionDeclaration: "function () { if (!this.isConnected || this.disabled || this.readOnly) return false; this.focus(); return this.getRootNode().activeElement === this; }", returnByValue: true
							});
							if (focused.exceptionDetails || focused.result.value !== true) { throw new Error('BrowserNodeNotEditable'); }
						} finally { await cdp.send('Runtime.releaseObject', { objectId }).catch(() => { }); }
					}
					signal.throwIfAborted(); await page.keyboard.insertText(action.text); break;
				case 'scroll': await page.mouse.wheel(action.deltaX, action.deltaY); break;
				case 'goBack': await page.goBack(); break;
				case 'reload': await page.reload(); break;
				case 'navigate': throw new Error('Browser navigation belongs to Main');
			}
			signal.throwIfAborted();
		});
	}
	public async cancelOperation(id: string): Promise<void> { this.operations.get(id)?.cancellation.abort(new Error('BrowserRequestCancelled')); }
	public async disposeSession(id: string): Promise<void> {
		for (const operation of this.operations.values()) {
			if (operation.sessionId === id) { operation.cancellation.abort(new Error('BrowserRequestCancelled')); }
		}
		this.connections.deleteAndDispose(id);
	}
	private async run<T>(id: string, sessionId: string, pageId: string, execute: (page: ConnectedPage, signal: AbortSignal) => Promise<T>): Promise<T> {
		this.assertNotDisposed();
		if (this.operations.has(id)) { throw new Error('Duplicate browser operation'); }
		const cancellation = new AbortController();
		this.operations.set(id, { sessionId, cancellation });
		try {
			let connection = this.connections.get(sessionId);
			if (!connection) { connection = this.instantiationService.createInstance(Connection, sessionId); this.connections.set(sessionId, connection); }
			const page = await connection.findPage(pageId, cancellation.signal);
			cancellation.signal.throwIfAborted();
			return await execute(page, cancellation.signal);
		} finally { this.operations.delete(id); }
	}
	protected override disposeCore(): void {
		for (const operation of this.operations.values()) { operation.cancellation.abort(new Error('BrowserCapabilityUnavailable')); }
		super.disposeCore();
	}
}

async function resolveNode(cdp: CDPSession, id: string): Promise<string> {
	if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) { throw new Error('BrowserNodeIdInvalid'); }
	const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: Number(id) });
	if (!resolved.object.objectId) { throw new Error('BrowserNodeUnavailable'); }
	return resolved.object.objectId;
}
function boundedJson(value: unknown): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > MAX_OBSERVATION_BYTES) { throw new Error('Browser observation is too large'); }
	return json;
}
