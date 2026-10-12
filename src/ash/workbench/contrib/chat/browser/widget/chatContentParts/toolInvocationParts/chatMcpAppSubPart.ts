import '../media/chatMarkdownPart.css';
import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { isWeb } from '../../../../../../../base/common/platform.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../../../../nls.js';
import { IAgentThreadService, type AgentAttachmentSource, type ChatContentPart, type ThreadItem } from '../../../../../../../platform/agentHost/common/agentService.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { IWebviewService, type IWebviewElement } from '../../../../../webview/browser/webview.js';

type ToolResult = Extract<ThreadItem, { readonly type: 'toolResult'; }>;
type Artifact = Extract<ChatContentPart, { readonly type: 'artifact'; }>['artifact'];

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
	private readonly height = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.height.event;
	private controller: AbortController | undefined;
	private initialized = false;
	private negotiating = false;
	private argumentsJson: string;
	private result: ToolResult;
	private sentResult: ToolResult | undefined;
	private inputSent = false;

	constructor(document: Document, public readonly coordinate: AgentAttachmentSource & { readonly contentIndex: number; }, artifact: Artifact, argumentsJson: string, result: ToolResult,
		@IAgentThreadService private readonly threads: IAgentThreadService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IThemeService private readonly themes: IThemeService,
		@INotificationService private readonly notifications: INotificationService,
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
		this._register(this.themes.onDidColorThemeChange(() => { if (this.initialized) void this.post('ui/notifications/host-context-changed', this.context()); }));
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
			const view = this.webviews.createWebviewElement({ title: localize('chat.mcpApp.label', 'Interactive MCP App'), options: {}, contentOptions: { allowScripts: true, localResourceRoots: [], messageProtocol: 'mcp' } });
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
		if (id === undefined) return;
		if (method === 'ui/initialize' && !this.negotiating && params?.protocolVersion === '2026-01-26' && boundedObject(params.appInfo) && boundedObject(params.appCapabilities)) {
			this.negotiating = true;
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'Ash MCP App host', version: '2026-01-26' }, hostCapabilities: {}, hostContext: this.context() } });
		} else if (method === 'ping' && this.negotiating) {
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, result: {} });
		} else {
			void this.view.value?.postMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: localize('chat.mcpApp.capabilityUnavailable', 'This host capability is not available.') } });
		}
	}

	private context(): Record<string, unknown> {
		return { theme: this.themes.getColorTheme().colorScheme === 'light' || this.themes.getColorTheme().colorScheme === 'hcLight' ? 'light' : 'dark', displayMode: 'inline', availableDisplayModes: ['inline'], platform: isWeb ? 'web' : 'desktop', locale: getNLSLanguage(), containerDimensions: { width: this.viewport.clientWidth, height: this.viewport.clientHeight } };
	}

	private deliver(): void {
		if (!this.inputSent) {
			let argumentsValue: unknown;
			try { argumentsValue = JSON.parse(this.argumentsJson); } catch { return; }
			if (!boundedObject(argumentsValue)) return;
			this.inputSent = true;
			void this.post('ui/notifications/tool-input', { arguments: argumentsValue });
		}
		if (this.sentResult === this.result) return;
		this.sentResult = this.result;
		const content: unknown[] = [];
		let structuredContent: unknown;
		let metadata: unknown;
		for (const part of this.result.content ?? []) {
			if (part.type === 'text') content.push({ type: 'text', text: part.text });
			else if (part.type === 'artifact' && part.artifact.data.type === 'json' && !part.artifact.truncated) {
				const json = JSON.parse(part.artifact.data.json);
				if (part.artifact.source.type === 'structuredResult') structuredContent = json;
				else if (part.artifact.source.type === 'mcpApp') metadata = json;
			}
		}
		if (!this.result.content) content.push({ type: 'text', text: this.result.text });
		void this.post('ui/notifications/tool-result', { content, isError: this.result.isError, ...(structuredContent === undefined ? {} : { structuredContent }), ...(metadata === undefined ? {} : { _meta: metadata }) });
	}

	private async post(method: string, params: unknown): Promise<void> {
		await this.view.value?.postMessage({ jsonrpc: '2.0', method, params });
	}

	private stop(): void {
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
		this.viewport.hidden = true;
		this.launch.hidden = false;
		this.close.hidden = true;
		this.height.fire();
	}
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
		seen.add(input);
		const entries = Object.entries(input);
		if (entries.length > 4096) return false;
		return entries.every(([key, nested]) => { bytes += key.length; return bytes <= 262_144 && valid(nested, depth + 1); });
	}
	return valid(value, 0);
}
