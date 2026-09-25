import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import {
	MarkdownElement,
	renderWorkbenchMarkdown,
	sanitizeMarkdownHtmlToString,
} from "../../../../../base/browser/markdownRenderer.js";
import {
	MarkdownPreview,
} from "../../../../../platform/markdown/browser/markdownPreview.js";
import {
	MarkdownDocumentView,
} from "../../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js";

function createDom(): JSDOM {
	return new JSDOM("<!DOCTYPE html><body></body>", {
		url: "https://ash.invalid/",
	});
}

test("workbench Markdown renders GFM structure through DOMPurify", () => {
	const dom = createDom();
	const html = renderWorkbenchMarkdown([
		"# Heading",
		"",
		"**bold** and `code`",
		"",
		"| A | B |",
		"| - | - |",
		"| 1 | 2 |",
	].join("\n"));
	const safeHtml = sanitizeMarkdownHtmlToString({
		ownerDocument: dom.window.document,
	}, html);

	assert.match(safeHtml, /<h1>Heading<\/h1>/);
	assert.match(safeHtml, /<strong>bold<\/strong>/);
	assert.match(safeHtml, /<code>code<\/code>/);
	assert.match(safeHtml, /<table>/);
	dom.window.close();
});

test('workbench Markdown strips raw HTML by default and honors explicit HTML support', () => {
	const dom = createDom();
	const source = 'a<em>b</em>c and `<span>code</span>`';
	const plain = new MarkdownElement({ ownerDocument: dom.window.document, markdown: source });
	const supported = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: { value: source, supportHtml: true },
	});

	assert.equal(plain.element.querySelector('em'), null);
	assert.match(plain.element.textContent ?? '', /abc and <span>code<\/span>/);
	assert.equal(supported.element.querySelector('em')?.textContent, 'b');
	assert.match(supported.element.textContent ?? '', /abc and <span>code<\/span>/);

	plain.dispose();
	supported.dispose();
	dom.window.close();
});

test("Markdown sanitization rejects executable markup and unsafe URLs", () => {
	const dom = createDom();
	const html = renderWorkbenchMarkdown({
		value: [
			"<script>globalThis.compromised = true</script>",
			"<img src=x onerror=\"globalThis.compromised = true\">",
			"[unsafe](javascript:alert(1))",
			"![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
			"[safe](https://example.com/docs)",
		].join("\n\n"),
		supportHtml: true,
	});
	const safeHtml = sanitizeMarkdownHtmlToString({
		ownerDocument: dom.window.document,
	}, html);

	assert.doesNotMatch(safeHtml, /<script/i);
	assert.doesNotMatch(safeHtml, /onerror/i);
	assert.doesNotMatch(safeHtml, /javascript:/i);
	assert.doesNotMatch(safeHtml, /image\/svg/i);
	assert.match(safeHtml, /href="https:\/\/example\.com\/docs"/);
	assert.match(safeHtml, /rel="noopener noreferrer"/);
	dom.window.close();
});

test("MarkdownElement owns DOM updates and delegates link activation", () => {
	const dom = createDom();
	const activated: string[] = [];
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: "[Ash](https://example.com/ash)",
		linkHandler: (href) => activated.push(href),
	});
	dom.window.document.body.append(markdown.element);

	const anchor = markdown.element.querySelector("a");
	assert.ok(anchor);
	const click = new dom.window.MouseEvent("click", {
		bubbles: true,
		cancelable: true,
	});
	anchor.dispatchEvent(click);
	assert.equal(click.defaultPrevented, true);
	assert.deepEqual(activated, ["https://example.com/ash"]);

	markdown.setMarkdown("Changed");
	assert.equal(markdown.element.textContent?.trim(), "Changed");
	markdown.dispose();
	assert.equal(markdown.element.isConnected, false);
	assert.throws(() => markdown.setMarkdown("late"), /already disposed/);
	dom.window.close();
});

test("Markdown task lists use the shared Checkbox presentation", () => {
	const dom = createDom();
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: "- [x] Done\n- [ ] Todo",
	});
	dom.window.document.body.append(markdown.element);

	const controls = markdown.element.querySelectorAll(".ash-markdown-checkbox");
	assert.equal(controls.length, 2);
	assert.equal(controls[0]?.classList.contains("ash-checkbox"), true);
	assert.equal(controls[0]?.querySelector<HTMLInputElement>("input")?.checked, true);
	assert.equal(controls[0]?.querySelector<HTMLInputElement>("input")?.disabled, true);
	assert.equal(controls[1]?.querySelector<HTMLInputElement>("input")?.checked, false);
	assert.equal(controls[1]?.querySelector<HTMLInputElement>("input")?.disabled, true);

	markdown.dispose();
	dom.window.close();
});

test("MarkdownPreview sanitizes content before creating iframe srcdoc", () => {
	const dom = createDom();
	const preview = new MarkdownPreview(dom.window.document.body, {
		markdown: [
			"# Preview",
			"",
			"| A | B |",
			"| - | - |",
			"| 1 | 2 |",
			"",
			"<script data-evil>globalThis.compromised = true</script>",
			"<img src=x onerror=alert(1)>",
			"[unsafe](javascript:alert(1))",
		].join("\n"),
	});

	assert.match(preview.element.srcdoc, /<h1>Preview<\/h1>/);
	assert.match(preview.element.srcdoc, /<table>/);
	assert.match(preview.element.srcdoc, /ash-markdown-preview/);
	assert.match(preview.element.srcdoc, /acquireAshWebviewApi/);
	assert.doesNotMatch(preview.element.srcdoc, /data-evil/);
	assert.doesNotMatch(preview.element.srcdoc, /onerror/i);
	assert.doesNotMatch(
		preview.element.srcdoc,
		/href\s*=\s*["']javascript:/i,
	);

	preview.dispose();
	dom.window.close();
});

test("MarkdownPreview validates iframe link messages before emitting", () => {
	const dom = createDom();
	const preview = new MarkdownPreview(dom.window.document.body, {
		markdown: "[safe](https://example.com/docs)",
	});
	const links: string[] = [];
	const registration = preview.onDidOpenLink((href) => links.push(href));
	const channel = preview.element.getAttribute(
		"data-ash-webview-channel",
	);
	assert.ok(channel);
	assert.ok(preview.element.contentWindow);

	dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
		source: preview.element.contentWindow,
		data: {
			channel,
			message: {
				type: "openLink",
				href: "https://example.com/docs",
			},
		},
	}));
	dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
		source: preview.element.contentWindow,
		data: {
			channel,
			message: {
				type: "openLink",
				href: "https://example.com/docs",
				unexpected: true,
			},
		},
	}));
	dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
		source: preview.element.contentWindow,
		data: {
			channel,
			message: {
				type: "openLink",
				href: "javascript:alert(1)",
			},
		},
	}));

	assert.deepEqual(links, ["https://example.com/docs"]);
	registration.dispose();
	preview.dispose();
	dom.window.close();
});

test("workbench Markdown document view owns link policy and updates", () => {
	const dom = createDom();
	const links: string[] = [];
	const view = new MarkdownDocumentView(dom.window.document.body, {
		markdown: "# Initial",
		openLink: (href) => {
			links.push(href);
		},
	});
	const channel = view.element.getAttribute("data-ash-webview-channel");
	assert.ok(channel);
	assert.ok(view.element.contentWindow);

	dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
		source: view.element.contentWindow,
		data: {
			channel,
			message: {
				type: "openLink",
				href: "https://example.com/workbench",
			},
		},
	}));
	assert.deepEqual(links, ["https://example.com/workbench"]);

	view.setMarkdown("## Updated");
	assert.match(view.element.srcdoc, /<h2>Updated<\/h2>/);
	view.dispose();
	assert.throws(() => view.setMarkdown("late"), /already disposed/);
	dom.window.close();
});
