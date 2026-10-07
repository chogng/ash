import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { mainWindow, type CodeWindow } from "../../../../base/browser/window.js";
import { Emitter } from "../../../../base/common/event.js";
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
	"img-src data: blob:",
	"media-src data: blob:",
	"font-src data:",
	"style-src 'unsafe-inline'",
	"script-src 'unsafe-inline'",
	"connect-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

let webviewInstanceCounter = 0;

/**
 * Hosts controlled HTML in an opaque-origin sandboxed iframe.
 *
 * Content gets script execution and a narrow `acquireAshWebviewApi()` message
 * function, but no same-origin access, navigation, forms, downloads, network
 * connections, Electron APIs, or Ash renderer capabilities.
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

	constructor(initInfo: WebviewInitInfo) {
		super();
		const instanceId = `webview_${++webviewInstanceCounter}`;
		this.instanceChannel = `ash-webview:${instanceId}`;
		this.forwardKeyboardEvents = initInfo.options.forwardKeyboardEvents === true;
		const element = h(mainWindow.document, "iframe");
		this.element = element;
		element.name = instanceId;
		element.className = "ash-webview";
		element.tabIndex = 0;
		element.setAttribute("sandbox", "allow-scripts");
		element.setAttribute("referrerpolicy", "no-referrer");
		element.setAttribute("credentialless", "");
		element.setAttribute("csp", WEBVIEW_CONTENT_SECURITY_POLICY);
		element.setAttribute("title", validateTitle(initInfo.title ?? "Webview"));
		element.style.border = "0";
		element.style.display = "block";
		element.style.width = "100%";
		element.style.height = "100%";
		this._register(toDisposable(() => {
			this.mountListeners.clear();
			this.discardPendingMessages();
			// Owners must receive blur and disposal before the registered emitters are released.
			this.setFocused(false);
			this.disposed.fire();
			element.srcdoc = "";
			element.remove();
		}));
	}

	public get isFocused(): boolean { return this.hasFocus; }

	public mountTo(parent: HTMLElement, targetWindow: CodeWindow): void {
		this.assertNotDisposed();
		if (this.isMounted) {
			throw new Error("WebviewElement is already mounted");
		}
		this.isMounted = true;
		const listeners = new DisposableStore();
		this.mountListeners.value = listeners;
		listeners.add(addDisposableListener(this.element, "focus", () => this.setFocused(true)));
		listeners.add(addDisposableListener(this.element, "blur", () => this.setFocused(false)));
		listeners.add(addDisposableListener<MessageEvent>(targetWindow, "message", event => {
			const contentWindow = this.element.contentWindow;
			if (!contentWindow || event.source !== contentWindow) {
				return;
			}
			if (event.data?.channel === `${this.channel}:lifecycle`) {
				if (event.data.type === "ready") {
					this.isReady = true;
					for (const pending of this.pendingMessages.splice(0)) {
						try {
							contentWindow.postMessage(pending.message, "*", [...pending.transfer]);
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
		this.element.setAttribute("data-ash-webview-channel", this.channel);
		this.element.srcdoc = createWebviewDocument(this.channel, html, this.forwardKeyboardEvents);
	}

	public setTitle(title: string): void {
		this.assertNotDisposed();
		this.element.setAttribute("title", validateTitle(title));
	}

	/** The opaque document requires targetOrigin '*'; content must check event.source === parent. */
	public async postMessage(message: unknown, transfer: readonly ArrayBuffer[] = []): Promise<boolean> {
		if (this.isDisposed) {
			return false;
		}
		if (!this.isReady) {
			return new Promise<boolean>((resolve, reject) => this.pendingMessages.push({ message, transfer, resolve, reject }));
		}
		this.element.contentWindow!.postMessage(message, "*", [...transfer]);
		return true;
	}

	public focus(): void {
		this.assertNotDisposed();
		this.element.focus();
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

function createWebviewDocument(channel: string, html: string, forwardKeyboardEvents: boolean): string {
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
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(WEBVIEW_CONTENT_SECURITY_POLICY)
		}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>${bootstrap}</script>
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
