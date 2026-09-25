import createDOMPurify, {
	type Config as DOMPurifyConfig,
	type DOMPurify,
	type WindowLike,
} from './dompurify/dompurify.js';
import type { TrustedHTML } from 'trusted-types/lib/index.js';
import { Schemas } from '../common/network.js';
import { reset } from './dom.js';

/** Safe markup that does not accept user input. */
export const basicMarkupHtmlTags = Object.freeze([
	'a', 'abbr', 'b', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
	'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li',
	'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'source',
	'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
	'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'video', 'wbr',
]);

export const defaultAllowedAttrs = Object.freeze([
	'href', 'target', 'src', 'alt', 'title', 'for', 'name', 'role', 'tabindex',
	'x-dispatch', 'required', 'checked', 'placeholder', 'type', 'start', 'width',
	'height', 'align',
]);

export type SanitizeAttributePredicate = (node: Element, data: { readonly attrName: string; readonly attrValue: string }) => boolean | string;

export interface SanitizeAttributeRule {
	readonly attributeName: string;
	readonly shouldKeep: SanitizeAttributePredicate;
}

export interface DomSanitizerConfig {
	readonly allowedTags?: {
		readonly override?: readonly string[];
		readonly augment?: readonly string[];
	};
	readonly allowedAttributes?: {
		readonly override?: ReadonlyArray<string | SanitizeAttributeRule>;
		readonly augment?: ReadonlyArray<string | SanitizeAttributeRule>;
	};
	readonly allowedLinkProtocols?: {
		readonly override?: readonly string[] | '*';
	};
	readonly allowRelativeLinkPaths?: boolean;
	readonly allowedMediaProtocols?: {
		readonly override?: readonly string[] | '*';
	};
	readonly allowRelativeMediaPaths?: boolean;
	readonly mediaSourceIsAllowed?: (source: string) => boolean;
	readonly replaceWithPlaintext?: boolean;
	readonly allowAriaAttributes?: boolean;
	readonly allowDataAttributes?: boolean;
}

export interface HtmlSanitizerOptions {
	readonly ownerDocument: Document;
	readonly config?: DomSanitizerConfig;
	readonly afterSanitizeAttributes?: (element: Element) => void;
}

const relativeProtocol = 'ash-relative-path';
const selfClosingTags = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
	'param', 'source', 'track', 'wbr',
]);

/** Sanitizes HTML for a Trusted Types HTML sink in the current document. */
export function sanitizeHtml(untrusted: string, config?: DomSanitizerConfig): TrustedHTML {
	const { purifier, purifierConfig } = configurePurifier(document, config);
	return purifier.sanitize(untrusted, { ...purifierConfig, RETURN_TRUSTED_TYPE: true }) as unknown as TrustedHTML;
}

/** Sanitizes HTML into a fragment owned by the destination document. */
export function sanitizeHtmlToFragment(untrusted: string, options: HtmlSanitizerOptions): DocumentFragment {
	const { purifier, purifierConfig } = configurePurifier(options.ownerDocument, options.config, options.afterSanitizeAttributes);
	return purifier.sanitize(untrusted, { ...purifierConfig, RETURN_DOM_FRAGMENT: true });
}

/** Replaces a node's children only after the complete fragment has been sanitized. */
export function safeSetInnerHtml(node: HTMLElement, untrusted: string, config?: DomSanitizerConfig): void {
	reset(node, sanitizeHtmlToFragment(untrusted, { ownerDocument: node.ownerDocument, config }));
}

/** Converts a removed tag into visible text without making its markup active. */
export function convertTagToPlaintext(node: Node): DocumentFragment | undefined {
	const ownerDocument = node.ownerDocument;
	if (!ownerDocument) {
		return undefined;
	}
	const fragment = ownerDocument.createDocumentFragment();
	if (node.nodeType === 8) {
		fragment.append(ownerDocument.createTextNode(`<!--${node.textContent ?? ''}-->`));
		return fragment;
	}
	if (node.nodeType !== 1) {
		return undefined;
	}
	const element = node as Element;
	const tagName = element.localName.toLowerCase();
	const attributes = Array.from(element.attributes, attribute => ` ${attribute.name}="${attribute.value}"`).join('');
	fragment.append(ownerDocument.createTextNode(`<${tagName}${attributes}>`));
	while (element.firstChild) {
		fragment.append(element.firstChild);
	}
	if (!selfClosingTags.has(tagName)) {
		fragment.append(ownerDocument.createTextNode(`</${tagName}>`));
	}
	return fragment;
}

function configurePurifier(
	ownerDocument: Document,
	config: DomSanitizerConfig = {},
	afterSanitizeAttributes?: (element: Element) => void,
): { purifier: DOMPurify; purifierConfig: DOMPurifyConfig } {
	const ownerWindow = ownerDocument.defaultView;
	if (!ownerWindow) {
		throw new Error('HTML sanitization requires a document with a window');
	}
	// A fresh instance binds hooks and Trusted Types policy to this document's realm.
	const purifier = createDOMPurify(ownerWindow as unknown as WindowLike);
	const allowedTags = [
		...(config.allowedTags?.override ?? basicMarkupHtmlTags),
		...(config.allowedTags?.augment ?? []),
	];
	const attributes = [
		...(config.allowedAttributes?.override ?? defaultAllowedAttrs),
		...(config.allowedAttributes?.augment ?? []),
	];
	const allowedAttributes = new Set<string>();
	const attributeRules = new Map<string, SanitizeAttributePredicate>();
	for (const attribute of attributes) {
		const name = (typeof attribute === 'string' ? attribute : attribute.attributeName).toLowerCase();
		allowedAttributes.add(name);
		if (typeof attribute === 'string') {
			attributeRules.delete(name);
		} else {
			attributeRules.set(name, attribute.shouldKeep);
		}
	}
	if (attributeRules.size > 0) {
		purifier.addHook('uponSanitizeAttribute', (element, event) => {
			const decision = attributeRules.get(event.attrName)?.(element, event);
			if (typeof decision === 'string') {
				event.attrValue = decision;
				event.keepAttr = true;
			} else if (decision !== undefined) {
				event.keepAttr = decision;
			}
		});
	}
	if (config.replaceWithPlaintext) {
		purifier.addHook('uponSanitizeElement', (node, event) => {
			if (event.allowedTags[event.tagName] || event.tagName === 'body') {
				return;
			}
			const replacement = convertTagToPlaintext(node);
			if (!replacement || !node.parentNode) {
				return;
			}
			if (node.nodeType === 8) {
				node.parentNode.insertBefore(replacement, node);
			} else {
				node.parentNode.replaceChild(replacement, node);
			}
		});
	}
	const linkProtocols = config.allowedLinkProtocols?.override ?? [Schemas.http, Schemas.https];
	const mediaProtocols = config.allowedMediaProtocols?.override ?? [Schemas.http, Schemas.https];
	purifier.addHook('afterSanitizeAttributes', element => {
		for (const name of ['href', 'src', 'poster']) {
			const value = element.getAttribute(name);
			if (value === null) {
				continue;
			}
			const isLink = name === 'href' && element.localName.toLowerCase() === 'a';
			const allowed = value.startsWith('#') && name === 'href'
				|| isAllowedUrl(value, isLink ? linkProtocols : mediaProtocols, isLink ? config.allowRelativeLinkPaths : config.allowRelativeMediaPaths);
			if (!allowed) {
				element.removeAttribute(name);
				continue;
			}
			if (!isLink && config.mediaSourceIsAllowed && !config.mediaSourceIsAllowed(value)) {
				const replacement = config.replaceWithPlaintext ? convertTagToPlaintext(element) : undefined;
				if (replacement && element.parentNode) {
					element.parentNode.replaceChild(replacement, element);
					return;
				}
				element.removeAttribute(name);
			}
		}
		afterSanitizeAttributes?.(element);
	});
	return {
		purifier,
		purifierConfig: {
			ALLOWED_TAGS: allowedTags,
			ALLOWED_ATTR: [...allowedAttributes],
			ALLOW_UNKNOWN_PROTOCOLS: true,
			ALLOW_ARIA_ATTR: config.allowAriaAttributes ?? true,
			ALLOW_DATA_ATTR: config.allowDataAttributes ?? true,
		},
	};
}

function isAllowedUrl(value: string, protocols: readonly string[] | '*', allowRelative = false): boolean {
	if (protocols === '*') {
		return true;
	}
	try {
		const protocol = new URL(value, `${relativeProtocol}://base/`).protocol.slice(0, -1);
		return protocols.includes(protocol)
			|| allowRelative && protocol === relativeProtocol
				&& !value.trimStart().startsWith('//')
				&& !value.trim().toLowerCase().startsWith(`${relativeProtocol}:`);
	} catch {
		return false;
	}
}
