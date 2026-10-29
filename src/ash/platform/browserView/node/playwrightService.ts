import {
	chromium,
	type Browser,
	type CDPSession,
	type ConnectOverCDPTransport,
	type Page,
	type Locator,
	type Frame,
	type Dialog,
} from 'playwright-core';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { promiseWithResolvers, raceCancellationError } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import { IBrowserViewGroupService } from '../common/browserViewGroup.js';
import type { CDPRequest } from '../common/cdp/types.js';
import type { IPlaywrightService } from '../common/playwrightService.js';
import type {
	BrowserViewAction,
	IBrowserViewObservation,
	IBrowserViewObservationOptions,
} from '../common/browserView.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { formatMatchedStyles, keyComputedProperties } from '../common/cssHelpers.js';
import { randomUUID } from 'node:crypto';

interface ConnectedPage {
	readonly page: Page;
	readonly cdp: CDPSession;
	readonly id: string;
	dialog?: Dialog;
}
const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

class Connection extends Disposable {
	private readonly pages = new WeakMap<Page, Promise<ConnectedPage>>();
	private browserConnection: Promise<Browser> | undefined;
	private get browser(): Promise<Browser> {
		return (this.browserConnection ??= this.connect());
	}
	constructor(
		private readonly sessionId: string,
		@IBrowserViewGroupService private readonly groups: IBrowserViewGroupService,
	) {
		super();
		this._register(
			toDisposable(() => {
				void this.browserConnection?.then(browser => browser.close()).catch(() => {});
			}),
		);
	}
	private async connect(): Promise<Browser> {
		const groupId = await this.groups.createGroup({ sandboxSessionId: this.sessionId });
		if (this.isDisposed) {
			await this.groups.destroyGroup(groupId);
			throw new Error('BrowserCapabilityUnavailable');
		}
		const resources = this._register(new DisposableStore());
		let closed = false;
		const transport: ConnectOverCDPTransport = {
			send: message => {
				if (!isRecord(message) || typeof message.id !== 'number' || typeof message.method !== 'string') {
					throw new TypeError('Invalid Playwright CDP request');
				}
				// Playwright's utility world needs isolation, without the universal
				// access flag that Main forbids for every browser protocol client.
				const request =
					message.method === 'Page.createIsolatedWorld' && isRecord(message.params)
						? { ...message, params: { ...message.params, grantUniveralAccess: false } }
						: message;
				void this.groups.sendCDPMessage(groupId, request as unknown as CDPRequest).catch(error => {
					transport.onmessage?.({
						id: message.id,
						sessionId: message.sessionId,
						error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
					});
				});
			},
			close: () => {
				if (closed) {
					return;
				}
				closed = true;
				transport.onclose?.();
				resources.dispose();
				void this.groups.destroyGroup(groupId).catch(() => {});
			},
		};
		resources.add(this.groups.onDynamicCDPMessage(groupId)(message => transport.onmessage?.(message)));
		resources.add(
			this.groups.onDynamicDidDestroy(groupId)(() => {
				closed = true;
				transport.onclose?.();
				resources.dispose();
			}),
		);
		resources.add(toDisposable(() => transport.close()));
		try {
			const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 30_000 });
			if (this.isDisposed) {
				await browser.close();
				throw new Error('BrowserCapabilityUnavailable');
			}
			return browser;
		} catch (error) {
			resources.dispose();
			throw error;
		}
	}
	private identify(page: Page): Promise<ConnectedPage> {
		let connection = this.pages.get(page);
		if (!connection) {
			connection = (async () => {
				const cdp = await page.context().newCDPSession(page);
				const { targetInfo } = await cdp.send('Target.getTargetInfo');
				const viewId = (targetInfo as typeof targetInfo & { browserViewId: unknown }).browserViewId;
				if (typeof viewId !== 'string') {
					throw new Error('BrowserCDPIdentityUnavailable');
				}
				const connected: ConnectedPage = { page, cdp, id: viewId };
				// Keep Playwright's pending dialog object until Chromium reports its completion.
				page.on('dialog', dialog => {
					connected.dialog = dialog;
				});
				cdp.on('Page.javascriptDialogClosed', () => {
					connected.dialog = undefined;
				});
				page.once('close', () => {
					void cdp.detach().catch(() => {});
				});
				return connected;
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
			void this.identify(page).then(
				candidate => {
					if (candidate.id === id) {
						found.resolve(candidate);
					}
				},
				error => found.reject(error),
			);
		};
		for (const context of contexts) {
			context.on('page', arrived);
		}
		try {
			for (const context of contexts) {
				for (const page of context.pages()) {
					if (!page.isClosed()) {
						arrived(page);
					}
				}
			}
			return await raceCancellationError(found.promise, signal, 'BrowserRequestCancelled');
		} finally {
			for (const context of contexts) {
				context.off('page', arrived);
			}
		}
	}
}

/** Playwright and element operations stay outside Main and renderer lifetimes. */
export class PlaywrightService extends Disposable implements IPlaywrightService {
	private readonly connections = this._register(new DisposableMap<string, Connection>());
	private readonly operations = new Map<
		string,
		{ readonly sessionId: string; readonly cancellation: AbortController }
	>();
	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
	}
	public async getObservation(
		operationId: string,
		sessionId: string,
		pageId: string,
		options: IBrowserViewObservationOptions,
	): Promise<IBrowserViewObservation> {
		return this.run(operationId, sessionId, pageId, async ({ page, cdp }, signal) => {
			await page.waitForLoadState('load');
			signal.throwIfAborted();
			const accessibilityTree = options.includeAccessibilityTree
				? boundedJson(await cdp.send('Accessibility.getFullAXTree'))
				: undefined;
			signal.throwIfAborted();
			let domSnapshot: string | undefined;
			if (options.includeDomSnapshot) {
				const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
					computedStyles: [...keyComputedProperties],
				});
				signal.throwIfAborted();
				await cdp.send('DOM.enable');
				await cdp.send('CSS.enable');
				const { root } = await cdp.send('DOM.getDocument');
				const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: ':focus' });
				if (nodeId) {
					const styles = formatMatchedStyles(await cdp.send('CSS.getMatchedStylesForNode', { nodeId }));
					domSnapshot = boundedJson({
						...snapshot,
						focusedElementStyles: {
							rulesText: styles.rulesText,
							referencedVars: [...styles.referencedVars],
							authorPropertyNames: [...styles.authorPropertyNames],
							userAgentPropertyNames: [...styles.userAgentPropertyNames],
						},
					});
				} else {
					domSnapshot = boundedJson(snapshot);
				}
			}
			signal.throwIfAborted();
			const png = options.includeScreenshot ? await page.screenshot({ type: 'png' }) : undefined;
			signal.throwIfAborted();
			if (png && png.byteLength > MAX_SCREENSHOT_BYTES) {
				throw new Error('BrowserScreenshotTooLarge');
			}
			return {
				targetId: pageId,
				url: page.url(),
				title: await page.title(),
				loading: false,
				...(accessibilityTree === undefined ? {} : { accessibilityTree }),
				...(domSnapshot === undefined ? {} : { domSnapshot }),
				...(png === undefined
					? {}
					: {
							screenshot: {
								mimeType: 'image/png' as const,
								dataBase64: png.toString('base64'),
								decodedLength: png.byteLength,
							},
						}),
			};
		});
	}
	public async performAction(
		operationId: string,
		sessionId: string,
		pageId: string,
		action: BrowserViewAction,
	): Promise<string | undefined> {
		if (action.type === 'cdp') {
			throw new Error('CDP connections belong to Main');
		}
		return this.run(operationId, sessionId, pageId, async (connected, signal) => {
			const { page, cdp } = connected;
			if (action.type === 'handleDialog') {
				// Wait for the actual modal before replying; Electron's dismissal hook must
				// never cancel a dialog that is still opening under a concurrent click.;
				const dialog =
					connected.dialog ??
					(await raceCancellationError(
						page.waitForEvent('dialog', { timeout: 5000 }),
						signal,
						'BrowserDialogUnavailable',
					));
				if (action.accept) {
					await dialog.accept(action.promptText ?? undefined);
				} else {
					await dialog.dismiss();
				}
				if (connected.dialog === dialog) {
					connected.dialog = undefined;
				}
				return undefined;
			}
			await page.waitForLoadState('load');
			signal.throwIfAborted();
			switch (action.type) {
				case 'runPlaywright':
					return runPageScript(page, cdp, action.code, signal);
				case 'hover': {
					const point = await nodePoint(cdp, action.target.nodeId);
					signal.throwIfAborted();
					await page.mouse.move(point.x, point.y);
					break;
				}
				case 'drag': {
					const source = await nodePoint(cdp, action.source.nodeId);
					const destination = await nodePoint(cdp, action.destination.nodeId);
					signal.throwIfAborted();
					await page.mouse.move(source.x, source.y);
					await page.mouse.down();
					try {
						signal.throwIfAborted();
						await page.mouse.move(destination.x, destination.y, { steps: 10 });
					} finally {
						await page.mouse.up();
					}
					break;
				}
				case 'click': {
					const point = await nodePoint(cdp, action.target.nodeId);
					signal.throwIfAborted();
					await page.mouse.click(point.x, point.y);
					break;
				}
				case 'typeText':
					if (action.target.type === 'element') {
						const objectId = await resolveNode(cdp, action.target.target.nodeId);
						try {
							const focused = await cdp.send('Runtime.callFunctionOn', {
								objectId,
								functionDeclaration:
									'function () { if (!this.isConnected || this.disabled || this.readOnly) return false; this.focus(); return this.getRootNode().activeElement === this; }',
								returnByValue: true,
							});
							if (focused.exceptionDetails || focused.result.value !== true) {
								throw new Error('BrowserNodeNotEditable');
							}
						} finally {
							await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
						}
					}
					signal.throwIfAborted();
					await page.keyboard.insertText(action.text);
					break;
				case 'scroll':
					await page.mouse.wheel(action.deltaX, action.deltaY);
					break;
				case 'goBack':
					await page.goBack();
					break;
				case 'reload':
					await page.reload();
					break;
				case 'navigate':
					throw new Error('Browser navigation belongs to Main');
			}
			signal.throwIfAborted();
			return undefined;
		});
	}
	public async cancelOperation(id: string): Promise<void> {
		this.operations.get(id)?.cancellation.abort(new Error('BrowserRequestCancelled'));
	}
	public async disposeSession(id: string): Promise<void> {
		for (const operation of this.operations.values()) {
			if (operation.sessionId === id) {
				operation.cancellation.abort(new Error('BrowserRequestCancelled'));
			}
		}
		this.connections.deleteAndDispose(id);
	}
	private async run<T>(
		id: string,
		sessionId: string,
		pageId: string,
		execute: (page: ConnectedPage, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		this.assertNotDisposed();
		if (this.operations.has(id)) {
			throw new Error('Duplicate browser operation');
		}
		const cancellation = new AbortController();
		this.operations.set(id, { sessionId, cancellation });
		try {
			let connection = this.connections.get(sessionId);
			if (!connection) {
				connection = this.instantiationService.createInstance(Connection, sessionId);
				this.connections.set(sessionId, connection);
			}
			const page = await connection.findPage(pageId, cancellation.signal);
			cancellation.signal.throwIfAborted();
			return await execute(page, cancellation.signal);
		} finally {
			this.operations.delete(id);
		}
	}
	protected override disposeCore(): void {
		for (const operation of this.operations.values()) {
			operation.cancellation.abort(new Error('BrowserCapabilityUnavailable'));
		}
		super.disposeCore();
	}
}

async function resolveNode(cdp: CDPSession, id: string): Promise<string> {
	if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) {
		throw new Error('BrowserNodeIdInvalid');
	}
	const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: Number(id) });
	if (!resolved.object.objectId) {
		throw new Error('BrowserNodeUnavailable');
	}
	return resolved.object.objectId;
}
async function nodePoint(cdp: CDPSession, id: string): Promise<{ x: number; y: number }> {
	const objectId = await resolveNode(cdp, id);
	try {
		const point = await cdp.send('Runtime.callFunctionOn', {
			objectId,
			returnByValue: true,
			functionDeclaration:
				"function () { this.scrollIntoView({ block: 'center', inline: 'center' }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }",
		});
		const value: unknown = point.result.value;
		if (
			point.exceptionDetails ||
			!isRecord(value) ||
			typeof value.x !== 'number' ||
			typeof value.y !== 'number' ||
			!Number.isFinite(value.x) ||
			!Number.isFinite(value.y)
		) {
			throw new Error('BrowserNodeUnavailable');
		}
		return { x: value.x, y: value.y };
	} finally {
		await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
	}
}

/** Opaque sandbox frames may live in a different Chromium process; Playwright owns that routing. */
async function runPageScript(page: Page, cdp: CDPSession, code: string, requestSignal: AbortSignal): Promise<string> {
	if (typeof code !== 'string' || code.trim().length === 0 || code.length > 32768) {
		throw new TypeError('Invalid browser script');
	}
	const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]);

	const name = `ashScript${randomUUID().replaceAll('-', '')}`;
	const pending = new Set<Promise<string>>();
	const evaluator = await page.context().newCDPSession(page);
	let parentContextId: number | undefined;
	let binding: Awaited<ReturnType<Page['exposeBinding']>> | undefined;
	let frame: Frame | undefined;
	let scriptSession: CDPSession | undefined;
	let calls = 0;
	let termination: Promise<unknown> | undefined;
	const terminate = (): void => {
		termination = Promise.allSettled([
			cdp.send('Runtime.terminateExecution'),
			...(scriptSession ? [scriptSession.send('Runtime.terminateExecution')] : []),
		]);
	};

	signal.addEventListener('abort', terminate, { once: true });
	let accepting = true;
	try {
		const { frameTree } = await cdp.send('Page.getFrameTree');
		parentContextId = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: name }))
			.executionContextId;
		binding = await page.exposeBinding(name, (source, payload: unknown) => {
			if (!accepting || !frame || source.frame !== frame || typeof payload !== 'string') {
				throw new Error('Browser script is unavailable');
			}
			const operation = (async (): Promise<string> => {
				try {
					signal.throwIfAborted();
					if (payload.length > 65536 || ++calls > 256 || pending.size >= 128) {
						throw new Error('Browser script call limit exceeded');
					}
					const message: unknown = JSON.parse(payload);
					if (!isRecord(message) || !Number.isSafeInteger(message.id)) {
						throw new TypeError('Invalid browser script call');
					}
					const response = JSON.stringify({
						value: await dispatchScriptCall(page, evaluator, message, signal),
					});
					if (response.length > 1024 * 1024) {
						throw new Error('Browser script result is too large');
					}
					return response;
				} catch (error) {
					return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
				}
			})();
			pending.add(operation);
			void operation.finally(() => pending.delete(operation));
			return operation;
		});
		signal.throwIfAborted();
		await cdp.send('Runtime.evaluate', {
			contextId: parentContextId,
			expression: `(() => { const f = document.createElement('iframe'); f.name = ${JSON.stringify(name)}; f.sandbox = 'allow-scripts'; f.srcdoc = '<!doctype html>'; f.hidden = true; f.style.setProperty('display', 'none', 'important'); document.documentElement.append(f); })()`,
		});
		// Electron can attach an out-of-process frame after its initial navigation event.
		// Resolve the frame from its DOM identity rather than waiting for a missed event.
		const element = await raceCancellationError(
			page.waitForSelector(`iframe[name="${name}"]`, { state: 'attached', timeout: 5000 }),
			signal,
			'BrowserScriptTimedOut',
		);
		try {
			frame = (await element?.contentFrame()) ?? undefined;
		} finally {
			await element?.dispose();
		}
		if (!frame) {
			throw new Error('Browser script frame is unavailable');
		}
		// Wait for the sandbox document, so an initial about:blank realm cannot select
		// the parent's terminator before Chromium moves the opaque frame to another process.
		// The predicate runs in the frame's DOM realm, not in this Node host.
		const ready = await raceCancellationError(
			frame.waitForFunction("location.href === 'about:srcdoc'", undefined, { timeout: 5000 }),
			signal,
			'BrowserScriptTimedOut',
		);
		await ready.dispose();
		try {
			scriptSession = await page.context().newCDPSession(frame);
		} catch (error) {
			// Same-process frames share the parent's execution terminator.
			if (!(error instanceof Error) || !error.message.includes("part of the parent frame's session")) {
				throw error;
			}
		}
		signal.throwIfAborted();

		const expression = `(() => {
			const send = globalThis[${JSON.stringify(name)}];
			let sequence = 0;
			const encode = (_key, value) => typeof value === 'function' ? { functionSource: String(value) } : value;
			const call = (path, method, args) => send(JSON.stringify({ id: ++sequence, path, method, args }, encode)).then(raw => {
				const response = JSON.parse(raw); if (response.error) throw new Error(response.error); return response.value;
			});
			const chain = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'nth', 'first', 'last', 'filter']);
			const facade = path => new Proxy(Object.create(null), { get(_target, method) {
				if (method === 'then') return undefined;
				if (typeof method !== 'string') return undefined;
				if (method === 'mouse' || method === 'keyboard') return facade([...path, { method, args: [] }]);
				if (chain.has(method)) return (...args) => facade([...path, { method, args }]);
				return (...args) => call(path, method, args);
			} });
			return (async page => { ${code}\n })(facade([]));
		})()`;
		const value = await raceCancellationError(frame.evaluate(expression), signal, 'BrowserScriptTimedOut');
		const output = JSON.stringify(value ?? null);
		if (output.length > 1024 * 1024) {
			throw new Error('Browser script result is too large');
		}
		return output;
	} finally {
		signal.removeEventListener('abort', terminate);
		accepting = false;
		// Electron may abandon pending child-command responses when its frame is removed.
		// Finish termination first, so the page's next operation cannot wait on a lost response.
		await termination;
		if (parentContextId !== undefined) {
			await cdp
				.send('Runtime.evaluate', {
					contextId: parentContextId,
					expression: `document.querySelector('iframe[name="${name}"]')?.remove()`,
				})
				.catch(() => {});
		}
		await scriptSession?.detach().catch(() => {});
		await binding?.dispose().catch(() => {});
		await evaluator.detach().catch(() => {});
		await Promise.allSettled(pending);
	}
}

async function dispatchScriptCall(
	page: Page,
	evaluator: CDPSession,
	message: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> {
	if (
		!Array.isArray(message.path) ||
		message.path.length > 12 ||
		typeof message.method !== 'string' ||
		!Array.isArray(message.args) ||
		message.args.length > 4
	) {
		throw new TypeError('Invalid browser script call');
	}
	let receiver: Page | Locator | Page['mouse'] | Page['keyboard'] = page;
	const locatorMethods = new Set([
		'locator',
		'getByRole',
		'getByText',
		'getByLabel',
		'getByPlaceholder',
		'getByTestId',
		'nth',
		'first',
		'last',
		'filter',
	]);
	for (const segment of message.path) {
		if (
			!isRecord(segment) ||
			typeof segment.method !== 'string' ||
			!Array.isArray(segment.args) ||
			segment.args.length > 3
		) {
			throw new TypeError('Invalid browser locator');
		}
		if (
			(segment.method === 'mouse' || segment.method === 'keyboard') &&
			receiver === page &&
			segment.args.length === 0
		) {
			receiver = page[segment.method];
			continue;
		}
		if (!locatorMethods.has(segment.method)) {
			throw new Error('Browser script locator method is unavailable');
		}
		const method = (receiver as unknown as Record<string, unknown>)[segment.method];
		if (typeof method !== 'function') {
			throw new Error('Browser script locator method is unavailable');
		}
		receiver = method.apply(receiver, segment.args) as Locator;
	}
	const allowed =
		receiver === page
			? new Set(['title', 'url', 'content', 'evaluate'])
			: receiver === page.mouse
				? new Set(['click', 'move', 'down', 'up', 'wheel'])
				: receiver === page.keyboard
					? new Set(['press', 'insertText', 'type'])
					: new Set([
							'click',
							'hover',
							'fill',
							'press',
							'check',
							'uncheck',
							'selectOption',
							'textContent',
							'innerText',
							'allTextContents',
							'count',
							'isVisible',
							'isEnabled',
							'getAttribute',
							'inputValue',
							'waitFor',
						]);
	if (!allowed.has(message.method)) {
		throw new Error('Browser script method is unavailable');
	}
	const args = [...message.args];
	if (message.method === 'evaluate' && isRecord(args[0]) && typeof args[0].functionSource === 'string') {
		args[0] = args[0].functionSource;
	}
	signal.throwIfAborted();
	if (receiver === page && message.method === 'evaluate') {
		if (typeof args[0] !== 'string' || args[0].length > 32768) {
			throw new TypeError('Invalid page evaluation');
		}
		const result = await raceCancellationError(
			evaluator.send('Runtime.evaluate', {
				expression: `(() => { const result = (${args[0]}); return typeof result === 'function' ? result(${JSON.stringify(args[1] ?? null)}) : result; })()`,
				awaitPromise: true,
				returnByValue: true,
			}),
			signal,
			'BrowserScriptTimedOut',
		);
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result.value;
	}
	const method = (receiver as unknown as Record<string, unknown>)[message.method];
	if (typeof method !== 'function') {
		throw new Error('Browser script method is unavailable');
	}
	// Bound waits even when script code issues calls without awaiting them.
	const timeouts = new Set([
		'click',
		'hover',
		'fill',
		'press',
		'check',
		'uncheck',
		'selectOption',
		'textContent',
		'innerText',
		'getAttribute',
		'inputValue',
		'waitFor',
	]);
	if (receiver !== page && receiver !== page.mouse && receiver !== page.keyboard && timeouts.has(message.method)) {
		const optionsIndex = ['fill', 'press', 'selectOption', 'getAttribute'].includes(message.method) ? 1 : 0;
		const options = args[optionsIndex];
		args[optionsIndex] = { ...(isRecord(options) ? options : {}), timeout: 5000 };
	}
	const result: unknown = await method.apply(receiver, args);
	signal.throwIfAborted();
	return result;
}
function boundedJson(value: unknown): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > MAX_OBSERVATION_BYTES) {
		throw new Error('Browser observation is too large');
	}
	return json;
}
