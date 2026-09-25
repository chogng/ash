import { Marked, type MarkedExtension, type MarkedOptions, type Token, type Tokens } from "../common/marked/marked.js";
import { addDisposableListener, reset, h } from "./dom.js";
import {
	type DomSanitizerConfig,
	type SanitizeAttributeRule,
	sanitizeHtmlToFragment,
} from "./domSanitize.js";
import { Checkbox } from "./ui/toggle/toggle.js";
import { type IMarkdownString, parseHrefAndDimensions } from "../common/htmlContent.js";
import { Disposable, DisposableStore, toDisposable } from "../common/lifecycle.js";
import { markdownEscapeEscapedIcons } from '../common/iconLabels.js';
import { onUnexpectedError } from '../common/errors.js';
import { appendIcon, getRegisteredIcon } from "./ui/lxicons/lxicon.js";
import { renderLabelWithIcons } from "./ui/iconlabel/iconLabels.js";
import { Schemas } from '../common/network.js';
import { URI } from '../common/uri.js';
import { localize } from '../../nls.js';
import { createObjectUrl } from './fileAccess.js';

export interface MarkdownElementOptions {
	readonly ownerDocument: Document;
	readonly markdown?: string | IMarkdownString;
	readonly breaks?: boolean;
	readonly markedOptions?: Pick<MarkedOptions, "breaks" | "gfm">;
	readonly fillInIncompleteTokens?: boolean;
	readonly markedExtensions?: readonly MarkedExtension[];
	readonly codeBlockRenderer?: (languageId: string, value: string) => Promise<HTMLElement>;
	readonly codeBlockRendererSync?: (languageId: string, value: string, raw?: string) => HTMLElement;
	readonly asyncRenderCallback?: () => void;
	readonly transformUri?: (href: string, kind: 'link' | 'image') => string;
	readonly sanitizerConfig?: MarkdownSanitizerConfig;
	readonly linkHandler?: (href: string) => void;
	readonly imageResourceLoader?: (resource: URI) => Promise<Blob>;
}

export interface MarkdownSanitizerOptions {
	readonly ownerDocument: Document;
	readonly markdown?: IMarkdownString;
	readonly sanitizerConfig?: MarkdownSanitizerConfig;
}

export interface MarkdownSanitizerConfig {
	readonly replaceWithPlaintext?: boolean;
	readonly allowedTags?: { readonly override: readonly string[] };
	readonly allowedAttributes?: { readonly override: ReadonlyArray<string | SanitizeAttributeRule> };
	readonly allowedLinkSchemes?: { readonly augment: readonly string[] };
	readonly remoteImageIsAllowed?: (uri: URI) => boolean;
}

export interface MarkdownRenderOptions {
	readonly markedOptions?: Pick<MarkedOptions, "breaks" | "gfm">;
	readonly fillInIncompleteTokens?: boolean;
	readonly markedExtensions?: readonly MarkedExtension[];
	readonly transformUri?: (href: string, kind: 'link' | 'image') => string;
}

export interface PlaintextMarkdownOptions {
	readonly includeCodeBlocksFences?: boolean;
	readonly useLinkFormatter?: boolean;
}

interface MarkdownParserInstance {
	readonly parser: Marked;
	readonly codeBlocks: Tokens.Code[];
}

const MAX_MARKDOWN_LENGTH = 4 * 1024 * 1024;
const ALLOWED_TAGS = [
	"a",
	"abbr",
	"b",
	"blockquote",
	"br",
	"caption",
	"code",
	"dd",
	"del",
	"details",
	"div",
	"dl",
	"dt",
	"em",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"img",
	"input",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"pre",
	"section",
	"s",
	"strong",
	"sub",
	"summary",
	"span",
	"sup",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"ul",
] as const;
const ALLOWED_ATTRIBUTES = [
	"alt",
	"checked",
	"class",
	"disabled",
	"href",
	"aria-label",
	{ attributeName: 'height', shouldKeep: isImageDimension },
	"rel",
	"src",
	"start",
	"title",
	"type",
	{ attributeName: 'width', shouldKeep: isImageDimension },
] as const;

function isImageDimension(element: Element, data: { readonly attrValue: string }): boolean {
	return element.tagName === 'IMG' && /^\d+$/u.test(data.attrValue);
}

const SAFE_DATA_IMAGE =
	/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
const RESOURCE_LINK_SCHEMES = [
	Schemas.vscodeFileResource, Schemas.vscodeRemote, Schemas.vscodeRemoteResource,
	Schemas.vscodeNotebookCell, Schemas.internal,
] as const;
const DEFAULT_LINK_SCHEMES = [
	Schemas.http, Schemas.https, Schemas.mailto, Schemas.file, Schemas.command,
	...RESOURCE_LINK_SCHEMES,
] as const;
const DEFAULT_MEDIA_SCHEMES = [
	Schemas.data, Schemas.http, Schemas.https, Schemas.file,
	Schemas.vscodeFileResource, Schemas.vscodeRemote, Schemas.vscodeRemoteResource,
] as const;
const RESOURCE_IMAGE_SCHEMES = [
	Schemas.file, Schemas.vscodeFileResource, Schemas.vscodeRemote, Schemas.vscodeRemoteResource,
] as const;
const SANITIZER_CONFIG: DomSanitizerConfig = {
	allowedTags: { override: ALLOWED_TAGS },
	allowedAttributes: { override: ALLOWED_ATTRIBUTES },
	allowedLinkProtocols: { override: DEFAULT_LINK_SCHEMES },
	allowRelativeLinkPaths: true,
	allowedMediaProtocols: { override: DEFAULT_MEDIA_SCHEMES },
	allowRelativeMediaPaths: true,
	allowAriaAttributes: true,
	allowDataAttributes: false,
};
const ALERT_ICON_IDS = {
	note: "info",
	tip: "lightning",
	important: "chat",
	warning: "warning",
	caution: "error",
} as const;
const MARKDOWN_COMMAND_RESOURCE_ID = "_workbench.downloadResource";

/**
 * Renders short Workbench Markdown into a normal DOM element.
 *
 * Parser output is always treated as untrusted and passed through DOMPurify
 * before it enters the document.
 */
export class MarkdownElement extends Disposable {
	private readonly ownerDocument: Document;
	private readonly breaks: boolean;
	private readonly markedOptions: Pick<MarkedOptions, "breaks" | "gfm">;
	private readonly fillInIncompleteTokens: boolean;
	private readonly markedExtensions: readonly MarkedExtension[];
	private readonly codeBlockRenderer: MarkdownElementOptions['codeBlockRenderer'];
	private readonly codeBlockRendererSync: MarkdownElementOptions['codeBlockRendererSync'];
	private readonly asyncRenderCallback: MarkdownElementOptions['asyncRenderCallback'];
	private readonly transformUri: MarkdownElementOptions['transformUri'];
	private readonly sanitizerConfig: MarkdownElementOptions['sanitizerConfig'];
	private readonly linkHandler: ((href: string) => void) | undefined;
	private readonly imageResourceLoader: MarkdownElementOptions['imageResourceLoader'];
	private readonly parsers = new Map<string, MarkdownParserInstance>();
	private readonly checkboxControls = this._register(new DisposableStore());
	private readonly imageResources = this._register(new DisposableStore());
	private active = true;
	private renderRevision = 0;

	readonly element: HTMLElement;

	constructor(options: MarkdownElementOptions) {
		super();
		this.ownerDocument = options.ownerDocument;
		this.breaks = options.breaks ?? false;
		this.markedOptions = {
			...options.markedOptions,
			breaks: options.markedOptions?.breaks ?? this.breaks,
		};
		this.fillInIncompleteTokens = options.fillInIncompleteTokens ?? false;
		this.markedExtensions = options.markedExtensions ?? [];
		this.codeBlockRenderer = options.codeBlockRenderer;
		this.codeBlockRendererSync = options.codeBlockRendererSync;
		this.asyncRenderCallback = options.asyncRenderCallback;
		this.transformUri = options.transformUri;
		this.sanitizerConfig = options.sanitizerConfig;
		this.linkHandler = options.linkHandler;
		this.imageResourceLoader = options.imageResourceLoader;
		this.element = h(options.ownerDocument, "div");
		this.element.className = "ash-markdown";
		this._register(addDisposableListener<MouseEvent>(
			this.element,
			"click",
			(event) => {
				const anchor = findAnchor(event.target);
				if (!anchor) return;
				event.preventDefault();
				event.stopPropagation();
				const href = anchor.getAttribute("href");
				if (href) this.linkHandler?.(href);
			},
		));
		this._register(toDisposable(() => {
			this.active = false;
			this.element.remove();
		}));
		this.setMarkdown(options.markdown ?? "");
	}

	setMarkdown(markdown: string | IMarkdownString): void {
		this.requireActive();
		const revision = ++this.renderRevision;
		const markdownString = typeof markdown === "string" ? { value: markdown } : markdown;
		const parser = this.getParser(markdownString);
		parser.codeBlocks.length = 0;
		const rawHtml = renderMarkdownWithParser(
			parser,
			markdownString,
			this.markedOptions,
			this.fillInIncompleteTokens,
		);
		const fragment = sanitizeMarkdownHtmlToFragment({
			ownerDocument: this.ownerDocument,
			markdown: markdownString,
			sanitizerConfig: this.sanitizerConfig,
		}, rawHtml);
		if (markdownString.supportAlertSyntax) {
			renderMarkdownAlertIcons(fragment, this.ownerDocument);
		}
		if (markdownString.supportThemeIcons) {
			renderMarkdownThemeIcons(fragment, this.ownerDocument);
		}
		this.checkboxControls.clear();
		this.imageResources.clear();
		upgradeMarkdownCheckboxes(
			fragment,
			this.ownerDocument,
			this.checkboxControls,
		);
		const workspaceImages: Array<{ readonly image: HTMLImageElement; readonly resource: URI }> = [];
		if (this.imageResourceLoader) {
			for (const image of fragment.querySelectorAll<HTMLImageElement>('img[src]')) {
				const resource = URI.parse(image.getAttribute('src')!);
				if (!RESOURCE_IMAGE_SCHEMES.some(scheme => resource.scheme === scheme)) continue;
				image.removeAttribute('src');
				workspaceImages.push({ image, resource });
			}
		}
		reset(
			this.element,
			fragment,
		);
		const pending: Promise<void>[] = [];
		if (this.imageResourceLoader) {
			for (const { image, resource } of workspaceImages) {
				pending.push(this.imageResourceLoader(resource).then(blob => {
					if (!this.active || revision !== this.renderRevision || !this.element.contains(image)) return;
					const ownerWindow = this.ownerDocument.defaultView;
					if (!ownerWindow) return;
					const objectUrl = createObjectUrl(ownerWindow, blob);
					this.imageResources.add(objectUrl.registration);
					image.src = objectUrl.url.toString();
				}).catch(onUnexpectedError));
			}
		}
		let codeBlockIndex = 0;
		for (const code of this.element.querySelectorAll<HTMLElement>('pre > code')) {
			const codeBlock = parser.codeBlocks[codeBlockIndex++];
			const languageClass = [...code.classList].find(name => name.startsWith('language-'));
			const languageId = codeBlockLanguageId(codeBlock?.lang ?? languageClass?.slice('language-'.length));
			const value = codeBlock?.text ?? (code.textContent ?? '').replace(/\n$/, '');
			if (this.codeBlockRendererSync) {
				code.replaceWith(this.codeBlockRendererSync(languageId, value, codeBlock?.raw));
				continue;
			}
			if (this.codeBlockRenderer) {
				pending.push(this.codeBlockRenderer(languageId, value).then(element => {
					if (this.active && revision === this.renderRevision && this.element.contains(code)) {
						code.replaceWith(element);
					}
				}).catch(onUnexpectedError));
			}
		}
		if (pending.length > 0) {
			void Promise.all(pending).then(() => {
				if (this.active && revision === this.renderRevision) this.asyncRenderCallback?.();
			});
		}
	}

	private getParser(markdown: IMarkdownString): MarkdownParserInstance {
		const key = `${markdown.supportHtml === true}:${markdown.supportAlertSyntax === true}`;
		let parser = this.parsers.get(key);
		if (!parser) {
			parser = createMarkdownParser(
				markdown.supportHtml === true,
				markdown.supportAlertSyntax === true,
				this.markedExtensions,
				this.transformUri,
			);
			this.parsers.set(key, parser);
		}
		return parser;
	}

	private requireActive(): void {
		if (!this.active) {
			throw new ReferenceError("MarkdownElement is already disposed");
		}
	}
}

/** Parses Workbench Markdown; sanitize the returned HTML before inserting it into the DOM. */
export function renderWorkbenchMarkdown(
	markdown: string | IMarkdownString,
	breaks = false,
	options: MarkdownRenderOptions = {},
): string {
	const markdownString = typeof markdown === "string" ? { value: markdown } : markdown;
	return renderMarkdownWithParser(
		createMarkdownParser(
			markdownString.supportHtml === true,
			markdownString.supportAlertSyntax === true,
			options.markedExtensions ?? [],
			options.transformUri,
		),
		markdownString,
		{
			...options.markedOptions,
			breaks: options.markedOptions?.breaks ?? breaks,
		},
		options.fillInIncompleteTokens ?? false,
	);
}

/** Reduces Markdown to readable text without creating HTML. */
export function renderAsPlaintext(markdown: string | IMarkdownString, options: PlaintextMarkdownOptions = {}): string {
	const value = typeof markdown === 'string' ? markdown : markdown.value;
	validateMarkdown(value);
	const parser = new Marked();
	return plaintextBlocks(parser.lexer(value, { gfm: true }), options).trim();
}

function plaintextBlocks(tokens: readonly Token[], options: PlaintextMarkdownOptions): string {
	const lines: string[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'code': {
				const code = token as Tokens.Code;
				lines.push(options.includeCodeBlocksFences ? `\`\`\`${code.lang ?? ''}\n${code.text}\n\`\`\`` : code.text);
				break;
			}
			case 'heading':
			case 'paragraph':
			case 'text': {
				const inline = token as Tokens.Heading | Tokens.Paragraph | Tokens.Text;
				lines.push(inline.tokens ? plaintextInline(inline.tokens, options) : inline.text);
				break;
			}
			case 'blockquote':
				lines.push(plaintextBlocks((token as Tokens.Blockquote).tokens, options));
				break;
			case 'list':
				lines.push((token as Tokens.List).items.map(item => plaintextBlocks(item.tokens, options)).join('\n'));
				break;
			case 'table': {
				const table = token as Tokens.Table;
				lines.push([table.header, ...table.rows].map(row => row.map(cell => plaintextInline(cell.tokens, options)).join('\t')).join('\n'));
				break;
			}
			case 'hr':
			case 'space':
			case 'html':
				break;
			default:
				if ('tokens' in token && token.tokens) lines.push(plaintextInline(token.tokens, options));
		}
	}
	return lines.filter(Boolean).join('\n');
}

function plaintextInline(tokens: readonly Token[], options: PlaintextMarkdownOptions): string {
	let result = '';
	for (const token of tokens) {
		switch (token.type) {
			case 'link': {
				const link = token as Tokens.Link;
				const label = plaintextInline(link.tokens, options);
				result += label || (options.useLinkFormatter ? link.href : '');
				break;
			}
			case 'image':
			case 'html':
				break;
			case 'br':
				result += '\n';
				break;
			default:
				if ('tokens' in token && token.tokens) result += plaintextInline(token.tokens, options);
				else if ('text' in token && typeof token.text === 'string') result += token.text;
		}
	}
	return result;
}

function renderMarkdownWithParser(
	parserInstance: MarkdownParserInstance,
	markdown: IMarkdownString,
	markedOptions: Pick<MarkedOptions, "breaks" | "gfm">,
	fillIncompleteTokens: boolean,
): string {
	validateMarkdown(markdown.value);
	const parserOptions = {
		...markedOptions,
		async: false,
		breaks: markedOptions.breaks ?? false,
		gfm: markedOptions.gfm ?? true,
	} as const;
	const markdownValue = markdown.supportThemeIcons
		? markdownEscapeEscapedIcons(markdown.value)
		: markdown.value;
	const value = fillIncompleteTokens
		? completeIncompleteMarkdown(markdownValue, parserInstance.parser, parserOptions)
		: markdownValue;
	const result = parserInstance.parser.parse(value, parserOptions);
	if (typeof result !== "string") {
		throw new Error("synchronous Markdown rendering returned a promise");
	}
	return result;
}

function createMarkdownParser(
	supportHtml: boolean,
	supportAlerts: boolean,
	markedExtensions: readonly MarkedExtension[],
	transformUri?: (href: string, kind: 'link' | 'image') => string,
): MarkdownParserInstance {
	const codeBlocks: Tokens.Code[] = [];
	const parser = new Marked();
	parser.use({ renderer: {
		code(token) {
			codeBlocks.push(token);
			return false;
		},
	} });
	if (supportAlerts) parser.use(createAlertExtension());
	parser.use({ renderer: {
		image(token): string {
			const { href, dimensions } = parseHrefAndDimensions(token.href);
			const source = escapeHtmlAttribute(transformUri?.(href, 'image') ?? href);
			const title = token.title ? ` title="${escapeHtmlAttribute(token.title)}"` : '';
			const size = dimensions.length ? ` ${dimensions.join(' ')}` : '';
			return `<img src="${source}" alt="${escapeHtmlAttribute(token.text)}"${title}${size}>`;
		},
	} });
	if (transformUri) {
		parser.use({ renderer: {
			link(token): string {
				const href = escapeHtmlAttribute(transformUri(token.href, 'link'));
				const title = token.title ? ` title="${escapeHtmlAttribute(token.title)}"` : '';
				return `<a href="${href}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
			},
		} });
	}
	parser.use(...markedExtensions);
	parser.use({ renderer: { html: ({ text }) => supportHtml ? text : '' } });
	return { parser, codeBlocks };
}

function codeBlockLanguageId(language: string | undefined): string {
	return language?.trim().split(/\s+/u, 1)[0] ?? '';
}

function escapeHtmlAttribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Sanitizes parser-produced Markdown HTML into a detached DOM fragment. */
export function sanitizeMarkdownHtmlToFragment(
	options: MarkdownSanitizerOptions,
	rawHtml: string,
): DocumentFragment {
	validateRawHtml(rawHtml);
	return sanitizeHtmlToFragment(rawHtml, {
		ownerDocument: options.ownerDocument,
		config: createMarkdownSanitizerConfig(options.markdown, options.sanitizerConfig),
		afterSanitizeAttributes: element => applyMarkdownAttributePolicy(element, options.markdown, options.sanitizerConfig),
	});
}

function createMarkdownSanitizerConfig(markdown: IMarkdownString | undefined, config: MarkdownSanitizerConfig | undefined): DomSanitizerConfig {
	return {
		...SANITIZER_CONFIG,
		allowedTags: { override: config?.allowedTags?.override ?? ALLOWED_TAGS },
		allowedAttributes: { override: config?.allowedAttributes?.override ?? ALLOWED_ATTRIBUTES },
		allowedLinkProtocols: {
			override: [...DEFAULT_LINK_SCHEMES, ...(config?.allowedLinkSchemes?.augment ?? [])],
		},
		allowedMediaProtocols: { override: DEFAULT_MEDIA_SCHEMES },
		mediaSourceIsAllowed: source => SAFE_DATA_IMAGE.test(source) || resolveMarkdownImageTarget(source, markdown, config) !== undefined,
		replaceWithPlaintext: config?.replaceWithPlaintext,
	};
}

/** Sanitizes parser-produced Markdown HTML into a serializable HTML string. */
export function sanitizeMarkdownHtmlToString(
	options: MarkdownSanitizerOptions,
	rawHtml: string,
): string {
	const fragment = sanitizeMarkdownHtmlToFragment(options, rawHtml);
	const checkboxControls = new DisposableStore();
	if (options.markdown?.supportAlertSyntax) {
		renderMarkdownAlertIcons(fragment, options.ownerDocument);
	}
	if (options.markdown?.supportThemeIcons) {
		renderMarkdownThemeIcons(fragment, options.ownerDocument);
	}
	upgradeMarkdownCheckboxes(fragment, options.ownerDocument, checkboxControls);
	const container = h(options.ownerDocument, "div");
	container.append(fragment);
	try {
		return container.innerHTML;
	} finally {
		checkboxControls.dispose();
	}
}

interface MarkdownCheckboxOwner {
	add(resource: Checkbox): Checkbox;
}

function upgradeMarkdownCheckboxes(
	fragment: DocumentFragment,
	ownerDocument: Document,
	owner: MarkdownCheckboxOwner,
): void {
	for (const input of fragment.querySelectorAll<HTMLInputElement>(
		'input[type="checkbox"]',
	)) {
		const detachedHost = h(ownerDocument, "span");
		const checkbox = owner.add(new Checkbox(detachedHost, {
			checked: input.checked,
			disabled: true,
			ariaLabel: input.closest('li')?.textContent?.trim() || localize('markdown.task', 'Task'),
		}));
		checkbox.element.classList.add("ash-markdown-checkbox");
		if (input.checked) checkbox.input.setAttribute("checked", "");
		input.replaceWith(checkbox.element);
	}
}

function applyMarkdownAttributePolicy(element: Element, markdown: IMarkdownString | undefined, config: MarkdownSanitizerConfig | undefined): void {
	if (element.hasAttribute("href")) {
		const href = element.getAttribute("href") ?? "";
		const target = resolveMarkdownLinkTarget(href, markdown, config);
		if (element.tagName !== "A" || !target) {
			element.removeAttribute("href");
		} else {
			element.setAttribute("href", target);
			element.setAttribute("rel", "noopener noreferrer");
		}
	}
	if (element.hasAttribute("src")) {
		if (element.tagName !== "IMG") {
			element.removeAttribute("src");
		} else if (markdown?.baseUri) {
			const source = element.getAttribute('src')!;
			if (!SAFE_DATA_IMAGE.test(source)) {
				element.setAttribute('src', new URL(source, markdown.baseUri.toString()).toString());
			}
		}
	}
	if (
		element.tagName === "INPUT" &&
		element.getAttribute("type") !== "checkbox"
	) {
		element.remove();
	}
}

function resolveMarkdownImageTarget(source: string, markdown: IMarkdownString | undefined, config?: MarkdownSanitizerConfig): string | undefined {
	try {
		const base = markdown?.baseUri ? new URL(markdown.baseUri.toString()) : undefined;
		const image = new URL(source, base);
		const scheme = image.protocol.slice(0, -1);
		if (scheme === Schemas.data) return undefined;
		if (!DEFAULT_MEDIA_SCHEMES.some(allowed => allowed === scheme) || image.username || image.password) return undefined;
		const isLocalFile = scheme === Schemas.file && !image.hostname;
		if (config?.remoteImageIsAllowed && !isLocalFile) {
			if (!config.remoteImageIsAllowed(URI.parse(image.toString()))) return undefined;
		}
		return image.toString();
	} catch {
		// Invalid destinations are removed by the sanitizer.
	}
	return undefined;
}

/** Resolves a Markdown link only when its scheme is allowed by the content trust policy. */
export function resolveMarkdownLinkTarget(href: string, markdown?: IMarkdownString, config?: MarkdownSanitizerConfig): string | undefined {
	if (href.startsWith("#")) return href;
	if (/^[\u0000-\u0020]|[\r\n\u0000]/u.test(href)) return undefined;
	const command = /^command:(?:\/\/\/)?([^/?#]+)(?:\?([^#]*))?(?:#.*)?$/i.exec(href);
	if (command) {
		let commandId: string;
		try { commandId = decodeURIComponent(command[1]!); }
		catch { return undefined; }
		if (!/^[A-Za-z0-9._-]+$/u.test(commandId)
			|| !isTrustedMarkdownCommand(commandId, markdown?.isTrusted)
			|| commandId === MARKDOWN_COMMAND_RESOURCE_ID) return undefined;
		return href;
	}
	try {
		const url = markdown?.baseUri ? new URL(href, markdown.baseUri.toString()) : new URL(href);
		if (url.protocol === "http:" || url.protocol === "https:") {
			if (!url.hostname || url.username || url.password) return undefined;
			return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : url.toString();
		}
		if (url.protocol === `${Schemas.mailto}:`) {
			return url.pathname.length > 0 ? url.toString() : undefined;
		}
		if (url.protocol === `${Schemas.file}:` && (markdown?.baseUri?.scheme === Schemas.file || markdown?.isTrusted === true)) {
			return url.toString();
		}
		if (RESOURCE_LINK_SCHEMES.some(scheme => url.protocol === `${scheme}:`)) {
			if (url.username || url.password) return undefined;
			return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : url.toString();
		}
		if (url.protocol !== 'javascript:' && config?.allowedLinkSchemes?.augment.includes(url.protocol.slice(0, -1))) {
			return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : url.toString();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Returns whether a Markdown link may be delegated to a Ash host. */
export function isSafeMarkdownLink(href: string, markdown?: IMarkdownString): boolean {
	return resolveMarkdownLinkTarget(href, markdown) !== undefined;
}

function isTrustedMarkdownCommand(commandId: string, trust: IMarkdownString["isTrusted"]): boolean {
	if (trust === true) return true;
	if (!trust || typeof trust !== "object") return false;
	return trust.enabledCommands?.includes(commandId) === true;
}

function renderMarkdownAlertIcons(fragment: DocumentFragment, ownerDocument: Document): void {
	for (const placeholder of fragment.querySelectorAll<HTMLElement>(".ash-markdown-alert-icon")) {
		const iconId = [...placeholder.classList]
			.find(className => className.startsWith("ash-markdown-alert-icon-"))
			?.slice("ash-markdown-alert-icon-".length);
		const icon = iconId ? getRegisteredIcon(iconId, ownerDocument) : undefined;
		if (!icon) {
			placeholder.remove();
			continue;
		}
		const iconElement = h(ownerDocument, "span");
		iconElement.className = "ash-icon-label-inline-icon ash-markdown-alert-icon";
		iconElement.setAttribute("aria-hidden", "true");
		appendIcon(icon, iconElement);
		placeholder.replaceWith(iconElement);
	}
}

function renderMarkdownThemeIcons(fragment: DocumentFragment, ownerDocument: Document): void {
	const view = ownerDocument.defaultView;
	if (!view) return;
	const walker = ownerDocument.createTreeWalker(fragment, view.NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let node = walker.nextNode();
	while (node) {
		const textNode = node as Text;
		if (!textNode.parentElement?.closest("code, pre") && textNode.data.includes("$(")) {
			textNodes.push(textNode);
		}
		node = walker.nextNode();
	}
	for (const textNode of textNodes) {
		const rendered = h(ownerDocument, "span");
		renderLabelWithIcons(rendered, textNode.data);
		if (!rendered.querySelector("svg.ash-icon")) continue;
		textNode.replaceWith(...Array.from(rendered.childNodes));
	}
}

function createAlertExtension(): MarkedExtension {
	return {
		renderer: {
			blockquote(token): string {
				const renderDefault = (): string => `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
				const firstParagraph = token.tokens[0];
				if (firstParagraph?.type !== "paragraph" || !firstParagraph.tokens?.length) return renderDefault();
				const firstText = firstParagraph.tokens[0];
				if (firstText?.type !== "text") return renderDefault();
				const marker = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i.exec(firstText.raw);
				if (!marker) return renderDefault();

				const severity = marker[1]!.toLowerCase() as keyof typeof ALERT_ICON_IDS;
				const heading = alertHeading(severity);
				const paragraphTokens = [...firstParagraph.tokens];
				paragraphTokens[0] = {
					...firstText,
					raw: firstText.raw.slice(marker[0].length),
					text: firstText.text.replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i, ""),
				};
				const blockquoteTokens = [...token.tokens];
				blockquoteTokens[0] = { ...firstParagraph, tokens: paragraphTokens };
				const content = this.parser.parse(blockquoteTokens);
				const paragraphEnd = content.indexOf("</p>");
				if (paragraphEnd < 0) return renderDefault();
				const paragraphContent = content.slice(3, paragraphEnd);
				const rest = content.slice(paragraphEnd + 4);
				return `<blockquote class="ash-markdown-alert ash-markdown-alert-${severity}"><p><span class="ash-markdown-alert-icon ash-markdown-alert-icon-${ALERT_ICON_IDS[severity]}"></span><strong class="ash-markdown-alert-label">${heading}</strong>${paragraphContent ? ` ${paragraphContent}` : ""}</p>${rest}</blockquote>\n`;
			},
		},
	};
}

function alertHeading(severity: keyof typeof ALERT_ICON_IDS): string {
	switch (severity) {
		case "note": return localize("markdown.alert.note", "Note");
		case "tip": return localize("markdown.alert.tip", "Tip");
		case "important": return localize("markdown.alert.important", "Important");
		case "warning": return localize("markdown.alert.warning", "Warning");
		case "caution": return localize("markdown.alert.caution", "Caution");
	}
}

function completeIncompleteMarkdown(markdown: string, parser: Marked, parserOptions: Pick<MarkedOptions, "breaks" | "gfm">): string {
	let value = markdown;
	for (let attempt = 0; attempt < 3; attempt++) {
		const tokens = parser.lexer(value, parserOptions);
		const tableCompletion = completeTrailingTable(value, tokens);
		if (tableCompletion) {
			value = tableCompletion;
			continue;
		}
		const token = lastContentToken(tokens);
		const textToken = token ? trailingTextToken(token) : undefined;
		if (!textToken) break;
		const completion = completeInlineTail(textToken.raw);
		if (!completion) break;
		const offset = value.lastIndexOf(textToken.raw);
		if (offset < 0 || value.slice(offset + textToken.raw.length).trim().length > 0) break;
		value = value.slice(0, offset + textToken.raw.length) + completion + value.slice(offset + textToken.raw.length);
	}
	return value;
}

function completeTrailingTable(markdown: string, tokens: Token[]): string | undefined {
	const paragraph = lastContentToken(tokens);
	if (paragraph?.type !== "paragraph") return undefined;
	const offset = markdown.lastIndexOf(paragraph.raw);
	if (offset < 0 || markdown.slice(offset + paragraph.raw.length).trim().length > 0) return undefined;
	const raw = paragraph.raw.trimEnd();
	const lines = raw.split("\n");
	if (lines.some(line => !/^\s*\|.*\|?\s*$/u.test(line))) return undefined;
	const headerCells = countTableCells(lines[0]!);
	if (headerCells < 1) return undefined;
	const separator = `|${" --- |".repeat(headerCells)}`;
	let completed: string;
	if (lines.length === 1) {
		completed = `${raw}\n${separator}`;
	} else if (lines.length === 2 && /^\s*\|[ :\-|]*$/u.test(lines[1]!)) {
		const lastLineOffset = raw.lastIndexOf("\n") + 1;
		completed = `${raw.slice(0, lastLineOffset)}${separator}`;
	} else {
		return undefined;
	}
	return markdown.slice(0, offset) + completed + markdown.slice(offset + paragraph.raw.length);
}

function countTableCells(line: string): number {
	const cells = line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|");
	return cells.length > 0 && cells.some(cell => cell.trim().length > 0) ? cells.length : 0;
}

function lastContentToken(tokens: Token[]): Token | undefined {
	for (let index = tokens.length - 1; index >= 0; index--) {
		const token = tokens[index]!;
		if (token.type !== "space" && token.type !== "html") return token;
	}
	return undefined;
}

function trailingTextToken(token: Token): Tokens.Text | undefined {
	if (token.type === "text" && 'text' in token) return token as Tokens.Text;
	if (token.type === "paragraph" || token.type === "heading" || token.type === "blockquote") {
		const nested = token.tokens?.at(-1);
		return nested ? trailingTextToken(nested) : undefined;
	}
	if (token.type === "list") {
		const nested = token.items.at(-1)?.tokens.at(-1);
		return nested ? trailingTextToken(nested) : undefined;
	}
	if (token.type === "list_item") {
		const nested = token.tokens?.at(-1);
		return nested ? trailingTextToken(nested) : undefined;
	}
	return undefined;
}

function completeInlineTail(raw: string): string {
	const codeDelimiter = findUnclosedBacktick(raw);
	if (codeDelimiter) return codeDelimiter;
	let completion = "";
	if (raw.lastIndexOf("](") > raw.lastIndexOf(")")) {
		completion = ")";
	} else {
		const openLabel = raw.lastIndexOf("[");
		if (openLabel > raw.lastIndexOf("]") && !isEscapedAt(raw, openLabel)) completion = "](\u0023)";
	}
	for (const delimiter of ["**", "__", "~~", "*", "_"]) {
		if (countUnescapedDelimiter(raw, delimiter) % 2 === 1) completion += delimiter;
	}
	return completion;
}

function findUnclosedBacktick(raw: string): string | undefined {
	const openRuns: number[] = [];
	for (let index = 0; index < raw.length;) {
		if (raw[index] !== "`" || isEscapedAt(raw, index)) {
			index++;
			continue;
		}
		let end = index + 1;
		while (raw[end] === "`") end++;
		const length = end - index;
		const openIndex = openRuns.lastIndexOf(length);
		if (openIndex >= 0) openRuns.splice(openIndex, 1);
		else openRuns.push(length);
		index = end;
	}
	return openRuns.length ? "`".repeat(openRuns[openRuns.length - 1]!) : undefined;
}

function countUnescapedDelimiter(raw: string, delimiter: string): number {
	let count = 0;
	for (let index = 0; index <= raw.length - delimiter.length;) {
		if (raw.startsWith(delimiter, index) && !isEscapedAt(raw, index)) {
			count++;
			index += delimiter.length;
		} else {
			index++;
		}
	}
	return count;
}

function isEscapedAt(raw: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && raw[cursor] === "\\"; cursor--) slashes++;
	return slashes % 2 === 1;
}

function findAnchor(target: EventTarget | null): HTMLAnchorElement | undefined {
	let current = target;
	while (current && typeof current === "object") {
		const element = current as Element;
		if (element.nodeType === 3) {
			current = element.parentElement;
			continue;
		}
		if (element.nodeType !== 1) return undefined;
		if (element.tagName === "A") return element as HTMLAnchorElement;
		current = element.parentElement;
	}
	return undefined;
}

function validateMarkdown(markdown: string): void {
	if (typeof markdown !== "string") {
		throw new TypeError("Markdown must be a string");
	}
	if (markdown.length > MAX_MARKDOWN_LENGTH) {
		throw new Error("Markdown exceeds the supported size");
	}
}

function validateRawHtml(rawHtml: string): void {
	if (typeof rawHtml !== "string") {
		throw new TypeError("Markdown HTML must be a string");
	}
	if (rawHtml.length > MAX_MARKDOWN_LENGTH * 4) {
		throw new Error("Markdown HTML exceeds the supported size");
	}
}
