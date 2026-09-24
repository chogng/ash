import { marked } from "marked";
import { addDisposableListener, reset, h } from "./dom.js";
import {
	type HtmlSanitizerConfig,
	sanitizeHtmlToFragment,
} from "./domSanitize.js";
import { Checkbox } from "./ui/toggle/toggle.js";
import { Disposable, DisposableStore, toDisposable } from "../common/lifecycle.js";

export interface MarkdownElementOptions {
	readonly ownerDocument: Document;
	readonly markdown?: string;
	readonly breaks?: boolean;
	readonly linkHandler?: (href: string) => void;
}

export interface MarkdownSanitizerOptions {
	readonly ownerDocument: Document;
}

const MAX_MARKDOWN_LENGTH = 4 * 1024 * 1024;
const ALLOWED_TAGS = [
	"a",
	"blockquote",
	"br",
	"code",
	"del",
	"details",
	"em",
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
	"s",
	"strong",
	"sub",
	"summary",
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
	"src",
	"start",
	"title",
	"type",
] as const;
const SANITIZER_CONFIG: HtmlSanitizerConfig = {
	ALLOWED_TAGS: [...ALLOWED_TAGS],
	ALLOWED_ATTR: [...ALLOWED_ATTRIBUTES],
	ALLOWED_NAMESPACES: ["http://www.w3.org/1999/xhtml"],
	ALLOW_ARIA_ATTR: false,
	ALLOW_DATA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false,
};
const SAFE_DATA_IMAGE =
	/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;

/**
 * Renders short Workbench Markdown into a normal DOM element.
 *
 * Parser output is always treated as untrusted and passed through DOMPurify
 * before it enters the document.
 */
export class MarkdownElement extends Disposable {
	private readonly ownerDocument: Document;
	private readonly breaks: boolean;
	private readonly linkHandler: ((href: string) => void) | undefined;
	private readonly checkboxControls = this._register(new DisposableStore());
	private active = true;

	readonly element: HTMLElement;

	constructor(options: MarkdownElementOptions) {
		super();
		this.ownerDocument = options.ownerDocument;
		this.breaks = options.breaks ?? false;
		this.linkHandler = options.linkHandler;
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

	setMarkdown(markdown: string): void {
		this.requireActive();
		const rawHtml = renderWorkbenchMarkdown(markdown, this.breaks);
		const fragment = sanitizeMarkdownHtmlToFragment({
			ownerDocument: this.ownerDocument,
		}, rawHtml);
		this.checkboxControls.clear();
		upgradeMarkdownCheckboxes(
			fragment,
			this.ownerDocument,
			this.checkboxControls,
		);
		reset(
			this.element,
			fragment,
		);
	}

	private requireActive(): void {
		if (!this.active) {
			throw new ReferenceError("MarkdownElement is already disposed");
		}
	}
}

/** Parses Workbench Markdown without trusting the returned HTML. */
export function renderWorkbenchMarkdown(
	markdown: string,
	breaks = false,
): string {
	validateMarkdown(markdown);
	const result = marked.parse(markdown, {
		async: false,
		breaks,
		gfm: true,
	});
	if (typeof result !== "string") {
		throw new Error("synchronous Markdown rendering returned a promise");
	}
	return result;
}

/** Sanitizes parser-produced Markdown HTML into a detached DOM fragment. */
export function sanitizeMarkdownHtmlToFragment(
	options: MarkdownSanitizerOptions,
	rawHtml: string,
): DocumentFragment {
	validateRawHtml(rawHtml);
	return sanitizeHtmlToFragment(rawHtml, {
		ownerDocument: options.ownerDocument,
		config: SANITIZER_CONFIG,
		afterSanitizeAttributes: applyMarkdownAttributePolicy,
	});
}

/** Sanitizes parser-produced Markdown HTML into a serializable HTML string. */
export function sanitizeMarkdownHtmlToString(
	options: MarkdownSanitizerOptions,
	rawHtml: string,
): string {
	const fragment = sanitizeMarkdownHtmlToFragment(options, rawHtml);
	const checkboxControls = new DisposableStore();
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
			disabled: input.disabled,
		}));
		checkbox.element.classList.add("ash-markdown-checkbox");
		if (input.checked) checkbox.input.setAttribute("checked", "");
		input.replaceWith(checkbox.element);
	}
}

function applyMarkdownAttributePolicy(element: Element): void {
	if (element.hasAttribute("href")) {
		const href = element.getAttribute("href") ?? "";
		if (element.tagName !== "A" || !isSafeMarkdownLink(href)) {
			element.removeAttribute("href");
		} else {
			element.setAttribute("rel", "noopener noreferrer");
		}
	}
	if (element.hasAttribute("src")) {
		const source = element.getAttribute("src") ?? "";
		if (element.tagName !== "IMG" || !SAFE_DATA_IMAGE.test(source)) {
			element.removeAttribute("src");
		}
	}
	if (
		element.tagName === "INPUT" &&
		element.getAttribute("type") !== "checkbox"
	) {
		element.remove();
	}
}

/** Returns whether a Markdown link may be delegated to a Ash host. */
export function isSafeMarkdownLink(href: string): boolean {
	if (href.startsWith("#")) return true;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function findAnchor(target: EventTarget | null): HTMLAnchorElement | undefined {
	let current = target;
	while (current && typeof current === "object") {
		const element = current as Element;
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
