import '../media/chatMarkdownPart.css';
import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IOpenerService } from '../../../../../../../platform/opener/common/opener.js';
import { isWeb } from '../../../../../../../base/common/platform.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { canceled } from '../../../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../../../../nls.js';
import { IAgentThreadService, type AgentAttachmentSource, type AgentMcpAppCsp, type ChatContentPart, type ThreadItem } from '../../../../../../../platform/agentHost/common/agentService.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { editorBackground } from '../../../../../../../platform/theme/common/colors/editorColors.js';
import { foreground, descriptionForeground, focusBorder } from '../../../../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { IWebviewService, type IWebviewElement } from '../../../../../webview/browser/webview.js';

type ToolResult = Extract<ThreadItem, { readonly type: 'toolResult'; }>;
type Artifact = Extract<ChatContentPart, { readonly type: 'artifact'; }>['artifact'];

/** The original Chat owns submission and input context; a View cannot choose another conversation. */
export interface IChatMcpAppDelegate {
	updateModelContext(source: AgentAttachmentSource & { readonly contentIndex: number; }, text: string): IDisposable;
	sendMessage(source: AgentAttachmentSource & { readonly contentIndex: number; }, text: string, signal: AbortSignal): Promise<void>;
}

/** One declared MCP App. The Webview owns isolation; the original tool result owns all data. */
export class ChatMcpAppSubPart extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly identity: string;
	private readonly viewport: HTMLElement;
	private readonly launch: HTMLButtonElement;
	private readonly close: HTMLButtonElement;
	private readonly view = this._register(new MutableDisposable<IWebviewElement>());
	private readonly retiringViews = this._register(new DisposableStore());
	private readonly listener = this._register(new MutableDisposable());
	private readonly modelContext = this._register(new MutableDisposable());
	private readonly height = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.height.event;
	private controller: AbortController | undefined;
	private readonly pendingCalls = new Map<string | number, AbortController>();
	private initialized = false;
	private negotiating = false;
	private argumentsJson: string;
	private result: ToolResult;
	private sentResult: string | undefined;
	private resultDelivery: AbortController | undefined;
	private inputSent = false;
	private appCsp: AgentMcpAppCsp | undefined;

	constructor(document: Document, public readonly coordinate: AgentAttachmentSource & { readonly contentIndex: number; }, artifact: Artifact, argumentsJson: string, result: ToolResult, private readonly delegate: IChatMcpAppDelegate | undefined,
		@IAgentThreadService private readonly threads: IAgentThreadService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IThemeService private readonly themes: IThemeService,
		@INotificationService private readonly notifications: INotificationService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		super();
		this.identity = JSON.stringify([coordinate, artifact.source, artifact.contentDigest]);
		this.argumentsJson = argumentsJson;
		this.result = result;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-chat-mcp-app';
		this.domNode.setAttribute('aria-label', localize('chat.mcpApp.label', 'Interactive MCP App'));
		this.launch = h(document, 'button');
		this.launch.type = 'button';
		this.launch.textContent = localize('chat.mcpApp.open', 'Open interactive view');
		this.close = h(document, 'button');
		this.close.type = 'button';
		this.close.textContent = localize('chat.mcpApp.close', 'Close interactive view');
		this.close.hidden = true;
		this.viewport = h(document, 'div');
		this.viewport.className = 'ash-chat-mcp-app-viewport';
		this.viewport.hidden = true;
		this.domNode.append(this.launch, this.close, this.viewport);
		this._register(addDisposableListener(this.launch, 'click', () => { void this.open(); }));
		this._register(addDisposableListener(this.close, 'click', () => { this.stop(); this.launch.focus(); }));
		this._register(addDisposableListener(document, 'fullscreenchange', () => {
			if (this.initialized) void this.post('ui/notifications/host-context-changed', this.context());
			this.height.fire();
		}));
		this._register(this.threads.onDidChangeConnection(() => this.stop()));
		this._register(this.themes.onDidColorThemeChange(() => { if (this.initialized) void this.post('ui/notifications/host-context-changed', this.context()); }));
		const resize = new ResizeObserver(() => { if (this.initialized && !this.isDisposed) void this.post('ui/notifications/host-context-changed', this.context()); });
		resize.observe(this.viewport);
		this._register(toDisposable(() => resize.disconnect()));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	protected override disposeCore(): void { this.stop(); super.disposeCore(); }

	public update(argumentsJson: string, result: ToolResult): void {
		this.argumentsJson = argumentsJson;
		this.result = result;
		if (this.initialized) this.deliver();
	}

	private async open(): Promise<void> {
		if (this.controller || this.view.value) return;
		const controller = new AbortController();
		this.controller = controller;
		this.launch.setAttribute('aria-busy', 'true');
		try {
			const resource = await this.threads.readToolResource(this.coordinate, controller.signal);
			if (controller.signal.aborted || this.isDisposed) return;
			if (!/^text\/html\s*;\s*profile\s*=\s*mcp-app(?:\s*;|\s*$)/iu.test(resource.mimeType)) throw new Error(localize('chat.mcpApp.invalidMime', 'The server did not return an MCP App document.'));
			const html = new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
			this.appCsp = resource.appCsp;
			const view = this.webviews.createWebviewElement({ title: localize('chat.mcpApp.label', 'Interactive MCP App'), options: {}, contentOptions: { allowScripts: true, localResourceRoots: [], messageProtocol: 'mcp', mcpCsp: this.appCsp } });
			this.view.value = view;
			this.listener.value = view.onMessage(event => this.receive(event.message));
			view.setHtml(html);
			view.mountTo(this.viewport, mainWindow);
			this.viewport.hidden = false;
			this.close.hidden = false;
			this.launch.hidden = true;
			view.focus();
			this.height.fire();
		} catch (error) {
			if (!controller.signal.aborted && !this.isDisposed) {
				this.stop();
				this.notifications.error(localize('chat.mcpApp.openFailed', 'Could not open the interactive view: {0}', String(error)));
			}
		} finally {
			if (this.controller === controller) { this.controller = undefined; this.launch.removeAttribute('aria-busy'); }
		}
	}

	private receive(value: unknown): void {
		if (!boundedObject(value) || value.jsonrpc !== '2.0') return;
		const method = value.method;
		if (typeof method !== 'string') return;
		const id = value.id;
		if (id !== undefined && !(typeof id === 'string' && id.length > 0 && id.length <= 256) && !(typeof id === 'number' && Number.isSafeInteger(id))) return;
		const params = boundedObject(value.params) ? value.params : undefined;
		if (method === 'ui/notifications/initialized' && id === undefined && this.negotiating) {
			this.initialized = true;
			this.deliver();
			return;
		}
		if (method === 'ui/notifications/size-changed' && this.initialized && id === undefined) {
			const height = params?.height;
			if (typeof height === 'number' && Number.isFinite(height) && height >= 0 && height <= 4096) {
				this.viewport.style.height = `${Math.min(Math.max(height, 120), 640)}px`;
				this.height.fire();
			}
			return;
		}
		if (method === 'notifications/cancelled' && id === undefined && (typeof params?.requestId === 'string' || typeof params?.requestId === 'number')) { this.pendingCalls.get(params.requestId)?.abort(); return; }
		if (id === undefined) return;
		if (this.initialized && this.pendingCalls.has(id)) {
			this.pendingCalls.get(id)?.abort();
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32600, message: localize('chat.mcpApp.busy', 'The App has too many pending requests or reused an active request ID.') } });
			return;
		}
		if (this.initialized && this.delegate && method === 'ui/update-model-context') {
			const content = params?.content ?? [];
			if (!params || !Array.isArray(content) || content.length > 64 || !content.every(block => boundedObject(block) && block.type === 'text' && typeof block.text === 'string') || params.structuredContent !== undefined && !boundedObject(params.structuredContent)) {
				void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: localize('chat.mcpApp.contextInvalid', 'App context must contain text or structured data.') } });
				return;
			}
			try {
				const text = [...content.map(block => block.text as string), ...(params.structuredContent === undefined ? [] : [JSON.stringify(params.structuredContent)])].join('\n\n');
				this.modelContext.value = this.delegate.updateModelContext(this.coordinate, text);
				void this.view.value?.postMessage({ jsonrpc: '2.0', id, result: {} });
			} catch (error) {
				void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: localize('chat.mcpApp.requestFailed', 'The App request failed: {0}', String(error)) } });
			}
			return;
		}
		const messageBlocks = params?.content === undefined ? [] : Array.isArray(params.content) ? params.content : [params.content];
		const messageText = messageBlocks.every(block => boundedObject(block) && block.type === 'text' && typeof block.text === 'string') ? messageBlocks.map(block => block.text as string).join('\n\n') : undefined;
		const chatMessage = method === 'ui/message' && this.delegate && params?.role === 'user' && messageBlocks.length > 0 && messageBlocks.length <= 64 && messageText?.trim();
		if (this.initialized && this.delegate && method === 'ui/message' && !chatMessage) {
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: localize('chat.mcpApp.messageInvalid', 'The App can send a nonempty user text message.') } });
			return;
		}
		const openLink = method === 'ui/open-link' && typeof params?.url === 'string';
		const displayMode = method === 'ui/request-display-mode' && ['inline', 'fullscreen', 'pip'].includes(String(params?.mode));
		const toolList = method === 'tools/list' && (!params || params.cursor === undefined);
		const toolCall = method === 'tools/call' && params && typeof params.name === 'string' && params.name.length > 0 && params.name.length <= 256 && (params.arguments === undefined || boundedObject(params.arguments));
		const resourceRead = method === 'resources/read' && params && typeof params.uri === 'string' && params.uri.length > 0 && params.uri.length <= 4096;
		if (this.initialized && (toolList || openLink || displayMode || params && (toolCall || resourceRead || chatMessage))) {
			if (this.pendingCalls.has(id) || this.pendingCalls.size >= 8) {
				this.pendingCalls.get(id)?.abort();
				void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32600, message: localize('chat.mcpApp.busy', 'The App has too many pending requests or reused an active request ID.') } });
				return;
			}
			const controller = new AbortController();
			this.pendingCalls.set(id, controller);
			const view = this.view.value;
			const operation = openLink
				? this.openLink(params!.url as string, controller.signal)
				: displayMode ? this.changeDisplayMode(params!.mode as string, controller.signal)
					: toolList
						? this.threads.listAppTools(this.coordinate, controller.signal).then(tools => ({ tools }))
						: toolCall
							? this.threads.invokeAppTool(this.coordinate, params!.name as string, JSON.stringify(params!.arguments ?? {}), controller.signal).then(result => resultPayload(result, this.threads, this.coordinate, controller.signal))
							: chatMessage ? Promise.resolve().then(() => {
								if (controller.signal.aborted) throw canceled();
								// Once accepted, an ordinary Chat message belongs to the conversation beyond the View lifetime.
								return this.delegate!.sendMessage(this.coordinate, messageText!, controller.signal);
							}).then(() => ({}))
								: this.threads.readAppResource(this.coordinate, params!.uri as string, controller.signal).then(resource => ({
									contents: [{
										uri: params!.uri, mimeType: resource.mimeType,
										...(resource.resourceMetadata ? { _meta: JSON.parse(resource.resourceMetadata) } : {}),
										...((resource.encoding === 'text' || resource.encoding === undefined && /^(?:text\/|application\/(?:json|xml)(?:;|$))/iu.test(resource.mimeType))
											? { text: new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes) } : { blob: bytesBase64(resource.bytes) }),
									}]
								}));
			void operation.then(result => {
				if (!controller.signal.aborted && view === this.view.value) void view?.postMessage({ jsonrpc: '2.0', id, result });
			}, error => {
				if (!controller.signal.aborted && view === this.view.value) void view?.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: localize('chat.mcpApp.requestFailed', 'The App request failed: {0}', String(error)) } });
			}).finally(() => { if (this.pendingCalls.get(id) === controller) this.pendingCalls.delete(id); });
			return;
		}

		if (method === 'ui/initialize' && !this.negotiating && params?.protocolVersion === '2026-01-26' && boundedObject(params.appInfo) && typeof params.appInfo.name === 'string' && params.appInfo.name.length > 0 && params.appInfo.name.length <= 128 && typeof params.appInfo.version === 'string' && params.appInfo.version.length <= 64 && boundedObject(params.appCapabilities)) {
			this.negotiating = true;
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'Ash MCP App host', version: '2026-01-26' }, hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, ...(this.delegate ? { message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } } : {}), sandbox: { permissions: {}, csp: this.appCsp ?? { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } }, hostContext: this.context() } });
		} else if (method === 'ping' && this.negotiating) {
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, result: {} });
		} else {
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: localize('chat.mcpApp.capabilityUnavailable', 'This host capability is not available.') } });
		}
	}

	private displayMode(): 'inline' | 'fullscreen' {
		return this.domNode.ownerDocument.fullscreenElement === this.domNode ? 'fullscreen' : 'inline';
	}

	private async changeDisplayMode(mode: string, signal: AbortSignal): Promise<{ mode: 'inline' | 'fullscreen'; }> {
		if (signal.aborted) throw canceled();
		const document = this.domNode.ownerDocument;
		try {
			if (mode === 'fullscreen' && document.fullscreenEnabled && this.displayMode() !== 'fullscreen') await this.domNode.requestFullscreen();
			else if (mode === 'inline' && this.displayMode() === 'fullscreen') await document.exitFullscreen();
		} catch { /* Fullscreen admission is owned by the browser; report its actual mode. */ }
		if (signal.aborted || this.isDisposed) {
			if (this.displayMode() === 'fullscreen') await document.exitFullscreen().catch(() => undefined);
			throw canceled();
		}
		return { mode: this.displayMode() };
	}

	private async openLink(value: string, signal: AbortSignal): Promise<{ isError: boolean; }> {
		if (signal.aborted) throw canceled();
		if (value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) return { isError: true };
		let url: URL;
		try { url = new URL(value); } catch { return { isError: true }; }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { isError: true };
		const opened = await this.opener.open(URI.parse(url.href), { openExternal: true, allowCommands: false, allowContributedOpeners: false });
		return { isError: !opened };
	}

	private context(): Record<string, unknown> {
		const theme = this.themes.getColorTheme();
		const variables = Object.fromEntries([['--color-background-primary', editorBackground], ['--color-text-primary', foreground], ['--color-text-secondary', descriptionForeground], ['--color-border-focus', focusBorder]].flatMap(([variable, token]) => { const color = theme.getColorCss(token!); return color ? [[variable!, color]] : []; }));
		return { styles: { variables }, theme: theme.colorScheme === 'light' || theme.colorScheme === 'hcLight' ? 'light' : 'dark', displayMode: this.displayMode(), availableDisplayModes: this.domNode.ownerDocument.fullscreenEnabled ? ['inline', 'fullscreen'] : ['inline'], platform: isWeb ? 'web' : 'desktop', locale: getNLSLanguage(), containerDimensions: { width: this.viewport.clientWidth, height: this.viewport.clientHeight } };
	}

	private deliver(): void {
		if (!this.inputSent) {
			let argumentsValue: unknown;
			try {
				argumentsValue = JSON.parse(this.argumentsJson);
				const app = this.result.content?.find(part => part.type === 'artifact' && part.artifact.source.type === 'mcpApp');
				if (app?.type === 'artifact' && app.artifact.data.type === 'json' && !app.artifact.truncated) {
					const payload = JSON.parse(app.artifact.data.json);
					if (boundedObject(payload) && boundedObject(payload.input)) argumentsValue = payload.input;
				}
			} catch { return; }
			if (!boundedObject(argumentsValue)) return;
			this.inputSent = true;
			void this.post('ui/notifications/tool-input', { arguments: argumentsValue });
		}
		const signature = JSON.stringify(this.result);
		if (this.sentResult === signature) return;
		this.sentResult = signature;
		this.resultDelivery?.abort();
		const controller = new AbortController();
		this.resultDelivery = controller;
		const view = this.view.value;
		void resultPayload(this.result, this.threads, this.coordinate, controller.signal).then(result => {
			if (!controller.signal.aborted && view === this.view.value) void view?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
		}, error => {
			if (!controller.signal.aborted && view === this.view.value) this.notifications.error(localize('chat.mcpApp.resultFailed', 'Could not load the App result: {0}', String(error)));
		}).finally(() => { if (this.resultDelivery === controller) this.resultDelivery = undefined; });
	}

	private async post(method: string, params: unknown): Promise<void> {
		await this.view.value?.postMessage({ jsonrpc: '2.0', method, params });
	}

	private stop(): void {
		if (this.displayMode() === 'fullscreen') void this.domNode.ownerDocument.exitFullscreen().catch(() => undefined);
		this.modelContext.clear();
		this.resultDelivery?.abort();
		this.resultDelivery = undefined;
		for (const controller of this.pendingCalls.values()) controller.abort();
		this.pendingCalls.clear();
		this.controller?.abort();
		this.controller = undefined;
		this.listener.clear();
		const view = this.view.clearAndLeak();
		if (view) {
			if (!this.initialized) view.dispose();
			else {
				// Allow a short, bounded teardown acknowledgment. Detached views cannot reach this part again.
				const lifetime = this.retiringViews.add(new DisposableStore());
				lifetime.add(view);
				let finished = false;
				const finish = (): void => { if (finished) return; finished = true; this.retiringViews.delete(lifetime); lifetime.dispose(); };
				lifetime.add(view.onMessage(event => { if (boundedObject(event.message) && event.message.id === 'ash-teardown') finish(); }));
				const timer = mainWindow.setTimeout(finish, 250);
				lifetime.add(toDisposable(() => mainWindow.clearTimeout(timer)));
				void view.postMessage({ jsonrpc: '2.0', id: 'ash-teardown', method: 'ui/resource-teardown', params: {} }).then(sent => { if (!sent) finish(); }, finish);
			}
		}
		this.launch.removeAttribute('aria-busy');
		this.initialized = false;
		this.negotiating = false;
		this.inputSent = false;
		this.sentResult = undefined;
		this.appCsp = undefined;
		this.viewport.hidden = true;
		this.launch.hidden = false;
		this.close.hidden = true;
		this.height.fire();
	}
}

/** Reconstructs only MCP result data; provider identities and transport handles never enter the View. */
async function resultPayload(result: ToolResult, threads: IAgentThreadService, source: AgentAttachmentSource, signal: AbortSignal): Promise<Record<string, unknown>> {
	const content: Record<string, unknown>[] = [];
	const contentMetadata = new Map<number, Record<string, unknown>>();
	for (const part of result.content ?? []) if (part.type === 'artifact' && part.artifact.source.type === 'viewMetadata' && part.artifact.mimeType === 'application/vnd.ash.mcp-content-metadata+json' && part.artifact.data.type === 'json') {
		const entries: unknown = JSON.parse(part.artifact.data.json);
		if (Array.isArray(entries)) for (const entry of entries) if (boundedObject(entry) && typeof entry.index === 'number') contentMetadata.set(entry.index, entry);
	}
	let structuredContent: unknown;
	let metadata: unknown;
	for (const [contentIndex, part] of (result.content ?? []).entries()) {
		if (signal.aborted) throw canceled();
		const previousLength = content.length;
		if (part.type === 'text') content.push({ type: 'text', text: part.text });
		else if (part.type === 'imageAttachment' || part.type === 'audioAttachment') {
			const media = await threads.readAttachment({ ...source, itemId: result.itemId, contentIndex }, signal);
			content.push({ type: part.type === 'imageAttachment' ? 'image' : 'audio', mimeType: media.mimeType, data: bytesBase64(media.bytes) });
		} else if (part.type === 'imageUrl' || part.type === 'audioUrl') {
			// Persisted attachments are preferred. Legacy inline media still contains its exact SDK bytes.
			const data = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(part.url);
			if (data) content.push({ type: part.type === 'imageUrl' ? 'image' : 'audio', mimeType: data[1], data: data[2] });
			else content.push({ type: 'text', text: part.url });
		}
		else if (part.type === 'artifact') {
			const artifact = part.artifact;
			if (artifact.data.type === 'json' && !artifact.truncated) {
				const json = JSON.parse(artifact.data.json);
				if (artifact.source.type === 'structuredResult') structuredContent = json;
				else if (artifact.source.type === 'viewMetadata' && artifact.mimeType === 'application/json') metadata = json;
				else if (artifact.source.type === 'mcpApp' && boundedObject(json) && Object.hasOwn(json, 'meta')) metadata ??= json.meta ?? undefined;
			}
			if (artifact.source.type === 'embeddedResource') {
				const resource = artifact.data.type === 'bytes' ? { uri: artifact.source.uri, mimeType: artifact.mimeType, blob: bytesBase64(artifact.data.bytes) } : { uri: artifact.source.uri, mimeType: artifact.mimeType, text: artifact.data.type === 'text' ? artifact.data.text : artifact.data.json };
				content.push({ type: 'resource', resource: { ...resource, ...(artifact.resourceMetadata ? { _meta: JSON.parse(artifact.resourceMetadata) } : {}) } });
			} else if (artifact.source.type === 'resourceLink') {
				const description = artifact.data.type === 'json' && !artifact.truncated ? JSON.parse(artifact.data.json) : {};
				content.push({ ...(boundedObject(description) ? description : {}), type: 'resource_link', uri: artifact.source.uri });
			}
		}
		const extra = contentMetadata.get(contentIndex);
		if (extra && content.length > previousLength) {
			const block = content.at(-1)!;
			if (extra.annotations !== undefined) block.annotations = extra.annotations;
			if (extra._meta !== undefined) block._meta = extra._meta;
		}
	}
	if (!result.content) content.push({ type: 'text', text: result.text });
	return { content, isError: result.isError, ...(structuredContent === undefined ? {} : { structuredContent }), ...(metadata === undefined ? {} : { _meta: metadata }) };
}

function bytesBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
	return btoa(chunks.join(''));
}

/** Limits untrusted postMessage values before inspecting or serializing them. Cycles are invalid JSON. */
function boundedObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	let nodes = 0;
	let bytes = 0;
	const seen = new Set<object>();
	function valid(input: unknown, depth: number): boolean {
		if (++nodes > 4096 || depth > 16) return false;
		if (typeof input === 'string') { bytes += input.length; return bytes <= 262_144; }
		if (input === null || typeof input === 'boolean') return true;
		if (typeof input === 'number') return Number.isFinite(input);
		if (typeof input !== 'object' || seen.has(input)) return false;
		if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return false;
		seen.add(input);
		const entries = Object.entries(input);
		if (entries.length > 4096) return false;
		return entries.every(([key, nested]) => { bytes += key.length; return bytes <= 262_144 && valid(nested, depth + 1); });
	}
	return valid(value, 0);
}
