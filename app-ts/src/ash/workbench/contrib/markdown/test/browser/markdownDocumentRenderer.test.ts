import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from '../../../../../base/common/uri.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import {
	MarkdownElement,
	renderAsPlaintext,
	renderWorkbenchMarkdown,
	resolveMarkdownLinkTarget,
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

test("workbench Markdown exposes Marked options and renderer extensions", () => {
	const withoutGfm = renderWorkbenchMarkdown("~~strikethrough~~", false, {
		markedOptions: { gfm: false },
	});
	const hardBreak = renderWorkbenchMarkdown("first\nsecond", false, {
		markedOptions: { breaks: true },
	});
	const extended = renderWorkbenchMarkdown("**Ash**", false, {
		markedExtensions: [{
			renderer: {
				strong(token) {
					return `<strong class=\"ash-strong\">${this.parser.parseInline(token.tokens)}</strong>`;
				},
			},
		}],
	});

	assert.match(withoutGfm, /~~strikethrough~~/);
	assert.doesNotMatch(withoutGfm, /<del>/);
	assert.match(hardBreak, /first<br>\s*second/);
	assert.match(extended, /<strong class=\"ash-strong\">Ash<\/strong>/);
});

test("Markdown sanitizes HTML returned by custom Marked renderers", () => {
	const dom = createDom();
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: "**unsafe output**",
		markedExtensions: [{
			renderer: {
				strong: () => '<img src="javascript:alert(1)" onerror="alert(1)">',
			},
		}],
	});

	const image = markdown.element.querySelector("img");
	assert.equal(image?.hasAttribute("src") ?? false, false);
	assert.equal(image?.hasAttribute("onerror") ?? false, false);
	assert.doesNotMatch(markdown.element.innerHTML, /javascript:|onerror/u);
	markdown.dispose();
	dom.window.close();
});

test("Markdown completes an incomplete streaming tail without changing closed content", () => {
	const html = renderWorkbenchMarkdown("**done** and [open label", false, {
		fillInIncompleteTokens: true,
	});
	assert.match(html, /<strong>done<\/strong>/);
	assert.match(html, /<a href=\"#\">open label<\/a>/);

	const table = renderWorkbenchMarkdown("| Name | State |", false, {
		fillInIncompleteTokens: true,
	});
	assert.match(table, /<table>/);
	assert.match(table, /<th>Name<\/th>/);
});

test("Markdown alerts and theme icons become accessible Ash presentation", () => {
	const dom = createDom();
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: {
			value: "> [!WARNING]\n> Read $(info) and `$(info)`",
			supportAlertSyntax: true,
			supportThemeIcons: true,
		},
	});

	const alert = markdown.element.querySelector("blockquote.ash-markdown-alert-warning");
	assert.ok(alert);
	assert.equal(alert.querySelector(".ash-markdown-alert-label")?.textContent, "Warning");
	assert.equal(alert.querySelectorAll("svg.ash-icon").length, 2);
	assert.equal(alert.querySelector(".ash-markdown-alert-icon")?.getAttribute("aria-hidden"), "true");
	assert.equal(alert.querySelector("code")?.textContent, "$(info)");

	markdown.dispose();
	dom.window.close();
});

test("Markdown supports all five GitHub alert severities", () => {
	const dom = createDom();
	const value = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
		.map(severity => `> [!${severity}]\n> Alert body`)
		.join('\n\n');
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: { value, supportAlertSyntax: true },
	});
	const alerts = [...markdown.element.querySelectorAll('blockquote.ash-markdown-alert')];

	assert.deepEqual(alerts.map(alert => ({
		severity: [...alert.classList].find(name => name.startsWith('ash-markdown-alert-') && name !== 'ash-markdown-alert'),
		label: alert.querySelector('.ash-markdown-alert-label')?.textContent,
		icon: alert.querySelector('svg.ash-icon')?.getAttribute('data-ash-icon-id'),
	})), [
		{ severity: 'ash-markdown-alert-note', label: 'Note', icon: 'info' },
		{ severity: 'ash-markdown-alert-tip', label: 'Tip', icon: 'lightning' },
		{ severity: 'ash-markdown-alert-important', label: 'Important', icon: 'chat' },
		{ severity: 'ash-markdown-alert-warning', label: 'Warning', icon: 'warning' },
		{ severity: 'ash-markdown-alert-caution', label: 'Caution', icon: 'error' },
	]);

	markdown.dispose();
	dom.window.close();
});

test("MarkdownString.appendText keeps literal theme icon syntax", () => {
	const dom = createDom();
	const value = new MarkdownString('', { supportThemeIcons: true })
		.appendText('literal $(info)')
		.appendMarkdown(' and $(info)');
	const markdown = new MarkdownElement({ ownerDocument: dom.window.document, markdown: value });

	assert.equal(markdown.element.querySelectorAll('svg.ash-icon').length, 1);
	const renderedText = (markdown.element.textContent ?? '').replaceAll('\u00a0', ' ');
	assert.match(renderedText, /literal \$\(info\)/u);
	markdown.dispose();
	dom.window.close();
});

test('Markdown plaintext keeps readable structure and optional code fences', () => {
	const value = '# Heading\n\nA **bold** [link](https://example.com)\n\n```ts\nconst x = 1;\n```';
	assert.equal(renderAsPlaintext(value), 'Heading\nA bold link\nconst x = 1;');
	assert.equal(renderAsPlaintext(value, { includeCodeBlocksFences: true }), 'Heading\nA bold link\n```ts\nconst x = 1;\n```');
	assert.equal(renderAsPlaintext('[](https://example.com)', { useLinkFormatter: true }), 'https://example.com');
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

test('Markdown transforms parsed links and images without changing raw HTML or code', () => {
	const transformed: Array<[string, string]> = [];
	const html = renderWorkbenchMarkdown({
		value: '[Link](https://example.com/old "title") ![Image](https://example.com/image|width=32) `<a href="https://example.com/old">` <a href="https://example.com/old">raw</a>',
		supportHtml: true,
	}, false, {
		transformUri: (href, kind) => {
			transformed.push([kind, href]);
			return `https://ash.invalid/${kind}`;
		},
	});
	assert.deepEqual(transformed, [
		['link', 'https://example.com/old'],
		['image', 'https://example.com/image'],
	]);
	assert.match(html, /<a href="https:\/\/ash\.invalid\/link" title="title">Link<\/a>/);
	assert.match(html, /<img src="https:\/\/ash\.invalid\/image" alt="Image" width="32">/);
	assert.match(html, /<code>&lt;a href=&quot;https:\/\/example\.com\/old&quot;&gt;<\/code>/);
	assert.match(html, /<a href="https:\/\/example\.com\/old">raw<\/a>/);
});

test('Markdown image dimensions survive sanitization only as numeric image attributes', () => {
	const dom = createDom();
	const html = renderWorkbenchMarkdown('![pixel](https://example.com/pixel.gif|height=24,width=48 "title")');
	const sanitized = sanitizeMarkdownHtmlToString({
		ownerDocument: dom.window.document,
		markdown: { value: '', baseUri: URI.parse('https://example.com/docs/') },
	}, html);
	const host = dom.window.document.createElement('div');
	host.innerHTML = sanitized;
	const image = host.querySelector('img');
	assert.deepEqual({
		src: image?.getAttribute('src'),
		width: image?.getAttribute('width'),
		height: image?.getAttribute('height'),
		title: image?.getAttribute('title'),
	}, {
		src: 'https://example.com/pixel.gif',
		width: '48',
		height: '24',
		title: 'title',
	});
	assert.doesNotMatch(sanitizeMarkdownHtmlToString({ ownerDocument: dom.window.document }, '<img src="https://example.com/a.png" width="5px" height="10" onerror="alert(1)">'), /width=|onerror=/i);
	dom.window.close();
});

test('Markdown preserves supported resource schemes and filters remote media by policy', () => {
	const dom = createDom();
	const resourceLinks = [
		'ash-remote://ssh+host/images/pixel.gif',
		'vscode-file://vscode-app/images/pixel.gif',
		'vscode-remote://ssh-remote+host/src/file.ts',
		'vscode-remote-resource://ssh-remote+host/images/pixel.gif',
		'vscode-notebook-cell:///workspace/notebook.ipynb#cell',
		'private:///workbench/resource',
	];
	for (const target of resourceLinks) {
		assert.equal(resolveMarkdownLinkTarget(target), target);
	}
	const remoteMarkdown = { value: '', baseUri: URI.parse('vscode-remote://ssh-remote+host/docs/readme.md') };
	assert.equal(resolveMarkdownLinkTarget('../src/file.ts', remoteMarkdown), 'vscode-remote://ssh-remote+host/src/file.ts');
	const ashMarkdown = { value: '', baseUri: URI.parse('ash-remote://ssh+host/docs/readme.md') };
	assert.equal(resolveMarkdownLinkTarget('../src/file.ts', ashMarkdown), 'ash-remote://ssh+host/src/file.ts');
	assert.equal(resolveMarkdownLinkTarget('vscode-file://user:secret@vscode-app/image.png'), undefined);
	const html = sanitizeMarkdownHtmlToString({ ownerDocument: dom.window.document },
		'<img src="vscode-file://vscode-app/images/pixel.gif"><img src="https://example.com/pixel.gif"><img src="data:image/svg+xml,<svg></svg>">');
	const host = dom.window.document.createElement('div');
	host.innerHTML = html;
	assert.deepEqual([...host.querySelectorAll('img')].map(image => image.getAttribute('src')), [
		'vscode-file://vscode-app/images/pixel.gif',
		'https://example.com/pixel.gif',
		null,
	]);
	assert.match(sanitizeMarkdownHtmlToString({ ownerDocument: dom.window.document, markdown: remoteMarkdown },
		'<img src="../images/pixel.gif">'), /src="vscode-remote:\/\/ssh-remote\+host\/images\/pixel\.gif"/);
	assert.match(sanitizeMarkdownHtmlToString({ ownerDocument: dom.window.document, markdown: ashMarkdown },
		'<img src="../images/pixel.gif">'), /src="ash-remote:\/\/ssh\+host\/images\/pixel\.gif"/);
	assert.equal(sanitizeMarkdownHtmlToString({
		ownerDocument: dom.window.document,
		markdown: { value: '', baseUri: URI.parse('https://example.com/docs/') },
		sanitizerConfig: { remoteImageIsAllowed: () => false },
	}, '<img src="https://example.com/pixel.gif">'), '<img>');
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

test('Markdown sanitizer applies explicit link, image, and plaintext policies', () => {
	const dom = createDom();
	const remoteImages: string[] = [];
	const html = sanitizeMarkdownHtmlToString({
		ownerDocument: dom.window.document,
		markdown: { value: '', baseUri: URI.parse('https://base.example/docs/') },
		sanitizerConfig: {
			allowedLinkSchemes: { augment: ['vscode'] },
			remoteImageIsAllowed: uri => {
				remoteImages.push(uri.toString());
				return uri.authority === 'remote.example';
			},
			replaceWithPlaintext: true,
		},
	}, '<a href="vscode://ash/resource">custom</a><img src="https://remote.example/image.png"><unknown>text</unknown>');
	assert.deepEqual({ html, remoteImages }, {
		html: '<a href="vscode://ash/resource" rel="noopener noreferrer">custom</a><img src="https://remote.example/image.png">&lt;unknown&gt;text&lt;/unknown&gt;',
		remoteImages: ['https://remote.example/image.png'],
	});
	dom.window.close();
});

test('Markdown link policy gates commands and resolves relative links', () => {
	const markdown = { value: '', baseUri: URI.parse('https://example.com/docs/'), isTrusted: { enabledCommands: ['ash.open'] } };
	assert.deepEqual({
		untrustedCommand: resolveMarkdownLinkTarget('command:ash.open'),
		trustedCommand: resolveMarkdownLinkTarget('command:ash.open', markdown),
		otherCommand: resolveMarkdownLinkTarget('command:ash.remove', markdown),
		reservedCommand: resolveMarkdownLinkTarget('command:_workbench.downloadResource', { value: '', isTrusted: true }),
		relative: resolveMarkdownLinkTarget('guide.md', markdown),
	}, {
		untrustedCommand: undefined,
		trustedCommand: 'command:ash.open',
		otherCommand: undefined,
		reservedCommand: undefined,
		relative: 'https://example.com/docs/guide.md',
	});
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

test('MarkdownElement replaces sanitized code blocks with a synchronous renderer', () => {
	const dom = createDom();
	const seen: Array<[string, string, string | undefined]> = [];
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: '```ts\nconst value = 1;\n```',
		codeBlockRendererSync: (languageId, value, raw) => {
			seen.push([languageId, value, raw]);
			const rendered = dom.window.document.createElement('span');
			rendered.className = 'highlighted-code';
			rendered.textContent = value;
			return rendered;
		},
	});
	assert.deepEqual(seen, [['ts', 'const value = 1;', '```ts\nconst value = 1;\n```']]);
	assert.equal(markdown.element.querySelector('.highlighted-code')?.textContent, 'const value = 1;');
	markdown.dispose();
	dom.window.close();
});

test('MarkdownElement ignores an asynchronous code block after Markdown changes', async () => {
	const dom = createDom();
	let resolveCodeBlock!: (element: HTMLElement) => void;
	let callbackCount = 0;
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: '```ts\nold\n```',
		codeBlockRenderer: () => new Promise(resolve => { resolveCodeBlock = resolve; }),
		asyncRenderCallback: () => { callbackCount += 1; },
	});
	dom.window.document.body.append(markdown.element);
	markdown.setMarkdown('new text');
	const staleElement = dom.window.document.createElement('span');
	staleElement.textContent = 'old';
	resolveCodeBlock(staleElement);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual({ text: markdown.element.textContent?.trim(), callbackCount }, { text: 'new text', callbackCount: 0 });
	markdown.dispose();
	dom.window.close();
});

test('MarkdownElement mounts an asynchronous code block and signals completion', async () => {
	const dom = createDom();
	let resolveCodeBlock!: (element: HTMLElement) => void;
	let resolveCompletion!: () => void;
	const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
	let callbackCount = 0;
	const markdown = new MarkdownElement({
		ownerDocument: dom.window.document,
		markdown: '```ts\nconst value = 2;\n```',
		codeBlockRenderer: () => new Promise(resolve => { resolveCodeBlock = resolve; }),
		asyncRenderCallback: () => { callbackCount += 1; resolveCompletion(); },
	});
	dom.window.document.body.append(markdown.element);
	const rendered = dom.window.document.createElement('span');
	rendered.className = 'highlighted-code';
	rendered.textContent = 'rendered';
	resolveCodeBlock(rendered);
	await completion;
	assert.deepEqual({ html: markdown.element.querySelector('pre')?.innerHTML, callbackCount }, {
		html: '<span class="highlighted-code">rendered</span>',
		callbackCount: 1,
	});
	markdown.dispose();
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
	assert.equal(controls[0]?.querySelector<HTMLInputElement>("input")?.getAttribute('aria-label'), 'Done');
	assert.equal(controls[1]?.querySelector<HTMLInputElement>("input")?.checked, false);
	assert.equal(controls[1]?.querySelector<HTMLInputElement>("input")?.disabled, true);
	assert.equal(controls[1]?.querySelector<HTMLInputElement>("input")?.getAttribute('aria-label'), 'Todo');

	markdown.setMarkdown({ value: '<input type="checkbox" checked>', supportHtml: true });
	assert.equal(markdown.element.querySelector<HTMLInputElement>('.ash-markdown-checkbox input')?.disabled, true);
	assert.equal(markdown.element.querySelector<HTMLInputElement>('.ash-markdown-checkbox input')?.getAttribute('aria-label'), 'Task');

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
			"> [!NOTE]",
			"> Preview alert",
			"",
			"<script data-evil>globalThis.compromised = true</script>",
			"<img src=x onerror=alert(1)>",
			"[unsafe](javascript:alert(1))",
		].join("\n"),
	});

	assert.match(preview.element.srcdoc, /<h1>Preview<\/h1>/);
	assert.match(preview.element.srcdoc, /<table>/);
	assert.match(preview.element.srcdoc, /blockquote class="ash-markdown-alert ash-markdown-alert-note"/);
	assert.match(preview.element.srcdoc, /ash-markdown-alert-label/);
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

test("MarkdownPreview resolves and validates relative resources against the source URI", () => {
	const dom = createDom();
	const baseUri = URI.parse("file:///workspace/docs/readme.md");
	const preview = new MarkdownPreview(dom.window.document.body, {
		markdown: "[source](../src/file.ts) ![image](../assets/pixel.png)",
		baseUri,
	});
	assert.match(preview.element.srcdoc, /href="file:\/\/\/workspace\/src\/file\.ts"/);
	assert.match(preview.element.srcdoc, /src="file:\/\/\/workspace\/assets\/pixel\.png"/);
	const links: string[] = [];
	const registration = preview.onDidOpenLink(href => links.push(href));
	const channel = preview.element.getAttribute("data-ash-webview-channel");
	assert.ok(channel);
	dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
		source: preview.element.contentWindow,
		data: {
			channel,
			message: { type: "openLink", href: "file:///workspace/src/file.ts" },
		},
	}));
	assert.deepEqual(links, ["file:///workspace/src/file.ts"]);
	registration.dispose();
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
		markdown: "# Initial\n\n[relative](./source.ts)",
		baseUri: URI.parse("file:///workspace/readme.md"),
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
	assert.match(view.element.srcdoc, /href="file:\/\/\/workspace\/source\.ts"/);

	view.setMarkdown("## Updated");
	assert.match(view.element.srcdoc, /<h2>Updated<\/h2>/);
	view.dispose();
	assert.throws(() => view.setMarkdown("late"), /already disposed/);
	dom.window.close();
});
