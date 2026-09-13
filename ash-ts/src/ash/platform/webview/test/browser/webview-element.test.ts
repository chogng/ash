import assert from "node:assert/strict";
import { test } from "mocha";

class FakeContentWindow {
	readonly messages: {
		readonly message: unknown;
		readonly targetOrigin: string;
		readonly transfer: readonly Transferable[];
	}[] = [];

	postMessage(
		message: unknown,
		targetOrigin: string,
		transfer: readonly Transferable[],
	): void {
		this.messages.push({ message, targetOrigin, transfer });
	}
}

class FakeIframe extends EventTarget {
	readonly contentWindow = new FakeContentWindow();
	readonly style: Record<string, string> = {};
	readonly attributes = new Map<string, string>();
	name = "";
	className = "";
	tabIndex = -1;
	srcdoc = "";
	focused = false;
	removed = false;

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	focus(): void {
		this.focused = true;
	}

	remove(): void {
		this.removed = true;
	}
}

class FakeWindow extends EventTarget {}

class FakeDocument {
	readonly defaultView = new FakeWindow();
	readonly iframe = new FakeIframe();

	createElement(tagName: string): FakeIframe {
		assert.equal(tagName, "iframe");
		return this.iframe;
	}
}

function fakeContainer(ownerDocument: FakeDocument): HTMLElement {
	return {
		ownerDocument,
		append: () => undefined,
	} as unknown as HTMLElement;
}

function dispatchMessage(
	target: EventTarget,
	source: unknown,
	data: unknown,
): void {
	const event = new Event("message");
	Object.defineProperties(event, {
		source: { value: source },
		data: { value: data },
	});
	target.dispatchEvent(event);
}

const {
	WebviewElement,
} = await import("../../../../platform/webview/browser/webviewElement.js");

test("webview element creates an opaque-origin sandbox document", () => {
	const ownerDocument = new FakeDocument();
	const webview = new WebviewElement(fakeContainer(ownerDocument), {
		title: "Markdown preview",
		initialHtml: "<h1>Preview</h1>",
	});

	assert.equal(
		ownerDocument.iframe.getAttribute("sandbox"),
		"allow-scripts",
	);
	assert.equal(
		ownerDocument.iframe.getAttribute("sandbox")?.includes(
			"allow-same-origin",
		),
		false,
	);
	assert.equal(
		ownerDocument.iframe.getAttribute("referrerpolicy"),
		"no-referrer",
	);
	assert.equal(ownerDocument.iframe.getAttribute("credentialless"), "");
	assert.match(
		ownerDocument.iframe.getAttribute("csp") ?? "",
		/connect-src 'none'/,
	);
	assert.match(ownerDocument.iframe.srcdoc, /Content-Security-Policy/);
	assert.match(ownerDocument.iframe.srcdoc, /default-src 'none'/);
	assert.match(ownerDocument.iframe.srcdoc, /acquireAshWebviewApi/);
	assert.match(ownerDocument.iframe.srcdoc, /<h1>Preview<\/h1>/);

	webview.dispose();
	assert.equal(ownerDocument.iframe.removed, true);
	assert.equal(ownerDocument.iframe.srcdoc, "");
});

test("webview messages require the owned iframe source and channel", () => {
	const ownerDocument = new FakeDocument();
	const webview = new WebviewElement(fakeContainer(ownerDocument));
	const messages: unknown[] = [];
	const registration = webview.onDidMessage((message) =>
		messages.push(message));
	const channel = ownerDocument.iframe.getAttribute(
		"data-ash-webview-channel",
	)!;

	dispatchMessage(
		ownerDocument.defaultView,
		{},
		{ channel, message: "wrong source" },
	);
	dispatchMessage(
		ownerDocument.defaultView,
		ownerDocument.iframe.contentWindow,
		{ channel: "wrong-channel", message: "wrong channel" },
	);
	dispatchMessage(
		ownerDocument.defaultView,
		ownerDocument.iframe.contentWindow,
		{ channel, message: { type: "ready" } },
	);

	assert.deepEqual(messages, [{ type: "ready" }]);
	registration.dispose();
	webview.dispose();
});

test("webview host messaging and content replacement stop after disposal", () => {
	const ownerDocument = new FakeDocument();
	const webview = new WebviewElement(fakeContainer(ownerDocument));

	assert.equal(webview.postMessage({ type: "update" }), true);
	assert.deepEqual(ownerDocument.iframe.contentWindow.messages, [{
		message: { type: "update" },
		targetOrigin: "*",
		transfer: [],
	}]);

	webview.setHtml("<p>Next</p>");
	assert.match(ownerDocument.iframe.srcdoc, /<p>Next<\/p>/);
	webview.focus();
	assert.equal(ownerDocument.iframe.focused, true);

	webview.dispose();
	assert.equal(webview.postMessage("late"), false);
	assert.throws(() => webview.setHtml("late"), /already disposed/);
});
