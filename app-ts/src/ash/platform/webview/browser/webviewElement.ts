import { addDisposableListener, h } from "../../../base/browser/dom.js";
import {
	Emitter,
	type Event,
} from "../../../base/common/event.js";
import {
	Disposable,

	toDisposable,
} from "../../../base/common/lifecycle.js";

export interface WebviewElementOptions {
	readonly title?: string;
	readonly initialHtml?: string;
}

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
export class WebviewElement extends Disposable {
	private readonly _onDidMessage = this._register(new Emitter<unknown>());
	private readonly channel: string;
	private active = true;

	readonly element: HTMLIFrameElement;
	readonly onDidMessage: Event<unknown> = this._onDidMessage.event;

	constructor(container: HTMLElement, options: WebviewElementOptions = {}) {
		super();
		const ownerDocument = container.ownerDocument;
		const targetWindow = ownerDocument.defaultView;
		if (!targetWindow) {
			throw new Error("WebviewElement requires a document with a window");
		}

		const instanceId = `webview_${++webviewInstanceCounter}`;
		this.channel = `ash-webview:${instanceId}`;
		const element = h(ownerDocument, "iframe");
		this.element = element;
		element.name = instanceId;
		element.className = "ash-webview";
		element.tabIndex = 0;
		element.setAttribute("sandbox", "allow-scripts");
		element.setAttribute("referrerpolicy", "no-referrer");
		element.setAttribute("credentialless", "");
		element.setAttribute("csp", WEBVIEW_CONTENT_SECURITY_POLICY);
		element.setAttribute("data-ash-webview-channel", this.channel);
		element.setAttribute(
			"title",
			validateTitle(options.title ?? "Webview"),
		);
		element.style.border = "0";
		element.style.display = "block";
		element.style.width = "100%";
		element.style.height = "100%";
		element.srcdoc = createWebviewDocument(
			this.channel,
			validateHtml(options.initialHtml ?? ""),
		);
		container.append(element);

		this._register(addDisposableListener<MessageEvent>(
			targetWindow,
			"message",
			(event) => {
				if (event.source !== element.contentWindow) return;
				const envelope = validateEnvelope(event.data, this.channel);
				if (envelope) this._onDidMessage.fire(envelope.message);
			},
		));
		this._register(toDisposable(() => {
			this.active = false;
			element.srcdoc = "";
			element.remove();
		}));
	}

	/** Replaces the complete sandbox document body. */
	setHtml(html: string): void {
		this.requireActive();
		this.element.srcdoc = createWebviewDocument(
			this.channel,
			validateHtml(html),
		);
	}

	/**
	 * Sends structured-clone data to the iframe.
	 *
	 * The target origin must be `*` because sandboxed srcdoc content has an
	 * opaque origin; the receiving content must validate `event.source`.
	 */
	postMessage(
		message: unknown,
		transfer: readonly Transferable[] = [],
	): boolean {
		if (!this.active || !this.element.contentWindow) return false;
		this.element.contentWindow.postMessage(
			message,
			"*",
			[...transfer],
		);
		return true;
	}

	focus(): void {
		this.requireActive();
		this.element.focus();
	}

	private requireActive(): void {
		if (!this.active) {
			throw new ReferenceError("WebviewElement is already disposed");
		}
	}
}

function createWebviewDocument(channel: string, html: string): string {
	const bootstrap = `(() => {
    const channel = ${JSON.stringify(channel)};
    let acquired = false;
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
  })();`;
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${
    escapeAttribute(WEBVIEW_CONTENT_SECURITY_POLICY)
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
