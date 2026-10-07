import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { mainWindow, type CodeWindow } from "../../../../base/browser/window.js";
import { Emitter } from "../../../../base/common/event.js";
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { webviewGenericCspSource } from '../common/webview.js';
import { loadLocalResource } from './resourceLoading.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IWebviewElement, WebviewInitInfo, WebviewMessageReceivedEvent } from "./webview.js";

interface WebviewMessageEnvelope {
	readonly channel: string;
	readonly message: unknown;
}

const MAX_WEBVIEW_HTML_LENGTH = 16 * 1024 * 1024;
const MAX_WEBVIEW_TITLE_LENGTH = 512;
const WEBVIEW_CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	`img-src ${webviewGenericCspSource} data: blob:`,
	`media-src ${webviewGenericCspSource} data: blob:`,
	`font-src ${webviewGenericCspSource} data:`,
	`style-src 'unsafe-inline' ${webviewGenericCspSource}`,
	`connect-src ${webviewGenericCspSource}`,
	"frame-src 'none'",
	"object-src 'none'",
	`base-uri ${webviewGenericCspSource}`,
	"form-action 'none'",
].join("; ");

/**
 * Owns one isolated origin. Its worker routes resource reads through the existing
 * file service; sandbox same-origin permission never exposes the Workbench origin.
 */
export class WebviewElement extends Disposable implements IWebviewElement {
	private readonly messages = this._register(new Emitter<WebviewMessageReceivedEvent>());
	public readonly onMessage = this.messages.event;
	private readonly keyboardEvents = this._register(new Emitter<KeyboardEvent>());
	public readonly onDidKeyboardEvent = this.keyboardEvents.event;
	private readonly focused = this._register(new Emitter<void>());
	public readonly onDidFocus = this.focused.event;
	private readonly blurred = this._register(new Emitter<void>());
	public readonly onDidBlur = this.blurred.event;
	private readonly disposed = this._register(new Emitter<void>());
	public readonly onDidDispose = this.disposed.event;
	private readonly mountListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly instanceChannel: string;
	private readonly frameOrigin: string;
	private readonly bootstrapUrl: URL;
	private readonly localResourceRoots: readonly URI[];
	private readonly allowScripts: boolean;
	private readonly resourceRequests = this._register(new MutableDisposable());
	private documentCancellation: CancellationTokenSource | undefined;
	private isBootstrapReady = false;
	private readonly forwardKeyboardEvents: boolean;
	private readonly pendingMessages: {
		message: unknown;
		transfer: readonly ArrayBuffer[];
		resolve: (sent: boolean) => void;
		reject: (error: unknown) => void;
	}[] = [];
	private channel = "";
	private documentVersion = 0;
	private html: string | undefined;
	private isReady = false;
	private hasFocus = false;
	private isMounted = false;
	public readonly element: HTMLIFrameElement;

	constructor(
		initInfo: WebviewInitInfo,
		@IFileService private readonly files: IFileService,
		@IWorkbenchEnvironmentService environment: IWorkbenchEnvironmentService,
	) {
		super();
		const instanceId = crypto.randomUUID();
		this.instanceChannel = `ash-webview:${instanceId}`;
		const endpoint = environment.webviewExternalEndpoint.replace('{{uuid}}', instanceId);
		const bootstrapAsset = new URL('./pre/index.html', import.meta.url);
		const workerAsset = new URL('./pre/service-worker.js?no-inline', import.meta.url);
		// File-hosted bundles use filesystem URLs; the isolated host exposes their asset names.
		const assetPath = (asset: URL): string => asset.protocol === `${Schemas.file}:`
			? `assets/${asset.pathname.slice(asset.pathname.lastIndexOf('/') + 1)}`
			: asset.pathname.replace(/^\//, '');
		this.bootstrapUrl = new URL(assetPath(bootstrapAsset), `${endpoint}/`);
		const workerUrl = new URL(assetPath(workerAsset), `${endpoint}/`);
		this.frameOrigin = `${this.bootstrapUrl.protocol}//${this.bootstrapUrl.host}`;
		this.bootstrapUrl.searchParams.set('worker', workerUrl.href);
		this.bootstrapUrl.hash = new URLSearchParams({ channel: this.instanceChannel }).toString();
		this.localResourceRoots = [...(initInfo.contentOptions?.localResourceRoots ?? [])];
		this.allowScripts = initInfo.contentOptions?.allowScripts === true;
		this.forwardKeyboardEvents = initInfo.options.forwardKeyboardEvents === true;
		const element = h(mainWindow.document, "iframe");
		this.element = element;
		element.name = instanceId;
		element.className = "ash-webview";
		element.tabIndex = 0;
		element.setAttribute("sandbox", "allow-scripts allow-same-origin");
		element.setAttribute("referrerpolicy", "no-referrer");
		element.setAttribute("title", validateTitle(initInfo.title ?? "Webview"));
		element.style.border = "0";
		element.style.display = "block";
		element.style.width = "100%";
		element.style.height = "100%";
		this._register(toDisposable(() => {
			if (this.isBootstrapReady && element.isConnected) {
				this.sendControl({ type: 'shutdown' });
			}
			this.resourceRequests.clear();
			this.mountListeners.clear();
			this.discardPendingMessages();
			// Owners must receive blur and disposal before the registered emitters are released.
			this.setFocused(false);
			this.disposed.fire();
			element.src = 'about:blank';
			element.remove();
		}));
	}

	public get isFocused(): boolean { return this.hasFocus; }

	public mountTo(parent: HTMLElement, targetWindow: CodeWindow): void {
		this.assertNotDisposed();
		if (this.isMounted) {
			throw new Error("WebviewElement is already mounted");
		}
		if (this.frameOrigin === targetWindow.location.origin) {
			throw new Error('Webview origin must be isolated from the Workbench');
		}
		this.isMounted = true;
		const listeners = new DisposableStore();
		this.mountListeners.value = listeners;
		listeners.add(addDisposableListener(this.element, "focus", () => {
			this.setFocused(true);
			// DOM focus targets the outer iframe; keyboard input belongs to its content document.
			if (this.isBootstrapReady) {
				this.sendControl({ type: 'focus' });
			}
		}));
		listeners.add(addDisposableListener(this.element, "blur", () => this.setFocused(false)));
		listeners.add(addDisposableListener<MessageEvent>(targetWindow, "message", event => {
			const contentWindow = this.element.contentWindow;
			if (!contentWindow || event.source !== contentWindow || event.origin !== this.frameOrigin) {
				return;
			}
			if (event.data?.channel === this.instanceChannel) {
				if (event.data.type === 'bootstrap-ready') {
					this.isBootstrapReady = true;
					this.sendDocument();
				} else if (event.data.type === 'load-resource') {
					void this.loadResource(event.data);
				} else if (event.data.type === 'bootstrap-error') {
					console.error('Webview bootstrap failed', event.data.error);
					this.discardPendingMessages();
				}
				return;
			}
			if (event.data?.channel === `${this.channel}:lifecycle`) {
				if (event.data.type === "ready") {
					this.isReady = true;
					// Focus can precede bootstrap or document loading when an editor pane opens.
					if (this.element.ownerDocument.activeElement === this.element) {
						this.sendControl({ type: 'focus' });
					}
					for (const pending of this.pendingMessages.splice(0)) {
						try {
							this.sendContentMessage(pending.message, pending.transfer);
							pending.resolve(true);
						} catch (error) {
							pending.reject(error);
						}
					}
				} else if (event.data.type === "focus" || event.data.type === "blur") {
					this.setFocused(event.data.type === "focus");
				}
				return;
			}
			if (this.forwardKeyboardEvents && event.data?.channel === `${this.channel}:keyboard`) {
				const keyboard = event.data;
				if ((keyboard.type !== 'keydown' && keyboard.type !== 'keyup') || typeof keyboard.key !== 'string' || typeof keyboard.code !== 'string') return;
				if (![keyboard.altKey, keyboard.ctrlKey, keyboard.shiftKey, keyboard.metaKey, keyboard.repeat].every(value => typeof value === 'boolean')) return;
				this.keyboardEvents.fire(new targetWindow.KeyboardEvent(keyboard.type, {
					key: keyboard.key, code: keyboard.code, altKey: keyboard.altKey, ctrlKey: keyboard.ctrlKey,
					shiftKey: keyboard.shiftKey, metaKey: keyboard.metaKey, repeat: keyboard.repeat,
					bubbles: true, cancelable: true,
				}));
				return;
			}
			const envelope = validateEnvelope(event.data, this.channel);
			if (envelope) {
				this.messages.fire({ message: envelope.message });
			}
		}));
		if (this.html === undefined) {
			this.setHtml("");
		}
		this.element.src = this.bootstrapUrl.href;
		parent.append(this.element);
	}

	public setHtml(html: string): void {
		this.assertNotDisposed();
		validateHtml(html);
		if (this.html === html) {
			return;
		}
		if (this.html !== undefined) {
			this.discardPendingMessages();
		}
		this.html = html;
		this.isReady = false;
		// Each document has its own channel: late readiness or edits cannot reach its replacement.
		this.channel = `${this.instanceChannel}:${++this.documentVersion}`;
		const cancellation = new CancellationTokenSource();
		this.resourceRequests.value = toDisposable(() => cancellation.dispose(true));
		this.documentCancellation = cancellation;
		this.element.setAttribute("data-ash-webview-channel", this.channel);
		this.sendDocument();
	}

	public setTitle(title: string): void {
		this.assertNotDisposed();
		this.element.setAttribute("title", validateTitle(title));
		this.sendControl({ type: 'title', title });
	}

	public async postMessage(message: unknown, transfer: readonly ArrayBuffer[] = []): Promise<boolean> {
		if (this.isDisposed) {
			return false;
		}
		if (!this.isReady) {
			return new Promise<boolean>((resolve, reject) => this.pendingMessages.push({ message, transfer, resolve, reject }));
		}
		this.sendContentMessage(message, transfer);
		return true;
	}

	public focus(): void {
		this.assertNotDisposed();
		this.element.focus();
		this.sendControl({ type: 'focus' });
	}

	private sendControl(message: object, transfer: readonly ArrayBuffer[] = []): void {
		this.element.contentWindow?.postMessage({ ...message, channel: this.instanceChannel }, this.frameOrigin, [...transfer]);
	}

	private sendContentMessage(message: unknown, transfer: readonly ArrayBuffer[]): void {
		this.sendControl({ type: 'message', documentChannel: this.channel, message, transfer }, transfer);
	}

	private sendDocument(): void {
		if (this.isBootstrapReady && this.html !== undefined) {
			this.sendControl({
				type: 'document',
				documentChannel: this.channel,
				title: this.element.title,
				html: createWebviewDocument(this.channel, this.html, this.forwardKeyboardEvents, this.allowScripts),
			});
		}
	}

	private async loadResource(request: { readonly id?: unknown; readonly documentChannel?: unknown; readonly url?: unknown; }): Promise<void> {
		if (!Number.isSafeInteger(request.id) || typeof request.url !== 'string' || request.documentChannel !== this.channel) {
			return;
		}
		const channel = this.channel;
		const token = this.documentCancellation!.token;
		let response: Awaited<ReturnType<typeof loadLocalResource>>;
		try {
			const url = new URL(request.url);
			const resourcePath = /^\/([a-z][a-z\d+.-]*)\/a([^/]*)(\/.*)$/.exec(url.pathname);
			if (url.origin !== webviewGenericCspSource || !resourcePath) {
				response = { status: 403, mimeType: 'application/octet-stream' };
			} else {
				const resource = URI.from({
					scheme: resourcePath[1]!,
					authority: decodeURIComponent(resourcePath[2]!),
					path: decodeURIComponent(resourcePath[3]!),
				});
				response = await loadLocalResource(resource, { roots: this.localResourceRoots }, this.files, token);
			}
		} catch (error) {
			if (isCancellationError(error)) {
				return;
			}
			console.error('Webview resource read failed', error);
			response = { status: 500, mimeType: 'application/octet-stream' };
		}
		if (this.isDisposed || token.isCancellationRequested || channel !== this.channel) {
			return;
		}
		const bytes = response.bytes?.slice().buffer;
		this.sendControl({
			type: 'resource-response',
			id: request.id,
			documentChannel: channel,
			status: response.status,
			mimeType: response.mimeType,
			bytes,
		}, bytes ? [bytes] : []);
	}

	private setFocused(focused: boolean): void {
		if (this.hasFocus === focused) {
			return;
		}
		this.hasFocus = focused;
		if (focused) {
			this.focused.fire();
		} else {
			this.blurred.fire();
		}
	}

	private discardPendingMessages(): void {
		for (const pending of this.pendingMessages.splice(0)) {
			pending.resolve(false);
		}
	}
}

function createWebviewDocument(channel: string, html: string, forwardKeyboardEvents: boolean, allowScripts: boolean): string {
	const nonce = crypto.randomUUID();
	const policy = `${WEBVIEW_CONTENT_SECURITY_POLICY}; script-src ${allowScripts ? `'unsafe-inline' ${webviewGenericCspSource}` : `'nonce-${nonce}'`}`;
	// Wait for content scripts to register handlers before delivering queued host messages.
	const bootstrap = `(() => {
    const channel = ${JSON.stringify(channel)};
    let acquired = false;
    const host = globalThis.parent;
    const notify = type => host.postMessage({ channel: channel + ':lifecycle', type }, '*');
    globalThis.addEventListener('focus', () => notify('focus'));
    globalThis.addEventListener('blur', () => notify('blur'));
    document.addEventListener('DOMContentLoaded', () => {
      notify('ready');
      if (document.hasFocus()) notify('focus');
    }, { once: true });
    Object.defineProperty(globalThis, "acquireAshWebviewApi", {
      configurable: false,
      enumerable: false,
      value: () => {
        if (acquired) {
          throw new Error("acquireAshWebviewApi may only be called once");
        }
        acquired = true;
        return Object.freeze({
          postMessage: (message) =>
            globalThis.parent.postMessage({ channel, message }, "*")
        });
      }
    });
    ${forwardKeyboardEvents ? `for (const type of ['keydown', 'keyup']) {
      document.addEventListener(type, event => {
        if (event.isComposing) return;
        if (type === 'keydown' && (event.key === 'F1' || (event.altKey && event.key === 'F2'))) event.preventDefault();
        globalThis.parent.postMessage({ channel: channel + ':keyboard', type,
          key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat }, '*');
      });
    }` : ''}
  })();`;
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)
		}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script nonce="${nonce}">${bootstrap}</script>
</head>
<body>${html}</body>
</html>`;
}

function validateEnvelope(
	value: unknown,
	channel: string,
): WebviewMessageEnvelope | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate).sort();
	if (
		keys.length !== 2 ||
		keys[0] !== "channel" ||
		keys[1] !== "message" ||
		candidate.channel !== channel
	) {
		return undefined;
	}
	return {
		channel,
		message: candidate.message,
	};
}

function validateHtml(value: string): string {
	if (typeof value !== "string") {
		throw new Error("webview HTML must be a string");
	}
	if (value.length > MAX_WEBVIEW_HTML_LENGTH) {
		throw new Error("webview HTML exceeds the supported size");
	}
	return value;
}

function validateTitle(value: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("webview title must be a non-empty string");
	}
	if (value.length > MAX_WEBVIEW_TITLE_LENGTH) {
		throw new Error("webview title is too long");
	}
	return value;
}

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;");
}
