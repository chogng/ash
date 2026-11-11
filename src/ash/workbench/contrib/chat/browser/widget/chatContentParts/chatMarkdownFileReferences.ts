import { deferredMarkdownLinkAttribute } from '../../../../../../base/browser/markdownRenderer.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { basename, extUri } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { FileKind, IFileService } from '../../../../../../platform/files/common/files.js';
import { extractSelection } from '../../../../../../platform/opener/common/opener.js';
import { IFileSearchService, type FileSearchDirectory } from '../../../../../../platform/search/common/fileSearch.js';
import { parseInlineFileReference } from '../../../common/widget/annotations.js';

const pathSegment = String.raw`[\p{L}\p{N}_.@+-]+`;
const filename = String.raw`(?:\.[\p{L}\p{N}_@+-]+|[\p{L}\p{N}_@+-]+(?:\.[\p{L}\p{N}_@+-]+)+)`;
const location = String.raw`(?:#L\d+|:\d+(?::\d+)?)?`;
const plainTextFileReference = new RegExp(
	String.raw`(?<![\p{L}\p{N}_.@/\\:+-])(?:(?:[a-z]:)?[/\\])?(?:${pathSegment}[/\\])*${filename}${location}(?![\p{L}\p{N}_@/\\:#+-]|\.[\p{L}\p{N}])`,
	'giu',
);
const literalContent = 'a, pre, blockquote, q, kbd, samp, .ash-katex-container, .ash-chat-code-block';

export function isMarkdownFileReference(href: string): boolean {
	return !href.startsWith('#') && (/^file:/iu.test(href) || !/^[\w+.-]+:/u.test(href));
}

/** Resolves references only in a completed reply, within its recorded execution directory. */
export class ChatMarkdownFileReferences extends Disposable {
	private readonly processed = new WeakSet<Node>();
	private readonly cancellation = new AbortController();
	private readonly results = new Map<string, Promise<string | undefined>>();
	private readonly basenames = new Map<string, Promise<URI | undefined>>();
	// A reply can mention many files. Keep recursive basename searches off the render path
	// and avoid sending a burst of filesystem searches to the host.
	private basenameSearch: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly root: HTMLElement,
		private readonly directory: FileSearchDirectory,
		private readonly onDidResolve: (anchor: HTMLAnchorElement) => void,
		@IFileService private readonly files: IFileService,
		@IFileSearchService private readonly search: IFileSearchService,
	) {
		super();
	}

	reconcile(): void {
		for (const anchor of this.root.querySelectorAll<HTMLAnchorElement>(`a[${deferredMarkdownLinkAttribute}]`)) {
			if (this.processed.has(anchor)) continue;
			this.processed.add(anchor);
			void this.resolve(anchor.getAttribute(deferredMarkdownLinkAttribute)!, true).then(href => {
				if (!href || !this.isCurrent(anchor)) return;
				this.activate(anchor, href);
			});
		}

		// Scan text nodes for plain-text file references to preserve emphasis, list structure, and explicit links.
		const walker = this.root.ownerDocument.createTreeWalker(this.root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
			acceptNode: node => {
				if (node.nodeType === 1) {
					return (node as Element).matches(literalContent) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
				}
				return this.processed.has(node) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
			},
		});
		const candidates: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) candidates.push(node as Text);
		for (const node of candidates) {
			this.processed.add(node);
			const code = node.parentElement?.closest('code');
			const matches = [...node.data.matchAll(plainTextFileReference)];
			if (!matches.length) continue;
			if (code && (code.childNodes.length !== 1 || matches[0]![0] !== node.data)) continue;
			const original = node.data;
			void Promise.all(matches.map(match => this.resolve(match[0], false))).then(hrefs => {
				if (!hrefs.some(Boolean) || !this.isCurrent(node) || node.data !== original) return;
				if (code) {
					const anchor = this.root.ownerDocument.createElement('a');
					code.replaceWith(anchor);
					anchor.append(node);
					this.activate(anchor, hrefs[0]!);
					return;
				}
				// Split from the right so earlier offsets remain valid and surrounding text stays in place.
				for (let index = matches.length - 1; index >= 0; index--) {
					const href = hrefs[index];
					if (!href) continue;
					const match = matches[index]!;
					node.splitText(match.index! + match[0].length);
					const label = node.splitText(match.index!);
					const anchor = this.root.ownerDocument.createElement('a');
					label.replaceWith(anchor);
					anchor.append(label);
					this.activate(anchor, href);
				}
			});
		}
	}

	private isCurrent(node: Node): boolean {
		return !this.isDisposed && this.root.contains(node);
	}

	private activate(anchor: HTMLAnchorElement, href: string): void {
		anchor.removeAttribute(deferredMarkdownLinkAttribute);
		anchor.setAttribute('href', href);
		anchor.setAttribute('rel', 'noopener noreferrer');
		this.onDidResolve(anchor);
	}

	private resolve(value: string, explicit: boolean): Promise<string | undefined> {
		const key = (explicit ? 'link:' : 'plain-text:') + value;
		let result = this.results.get(key);
		if (!result) {
			result = this.resolveTarget(value, explicit).catch(() => undefined);
			this.results.set(key, result);
		}
		return result;
	}

	private async resolveTarget(value: string, explicit: boolean): Promise<string | undefined> {
		const file = explicit && /^file:/iu.test(value) ? parseInlineFileReference(value) : undefined;
		if (file) {
			if (this.directory.resource.scheme !== Schemas.file || !await this.isFile(file.uri)) return undefined;
			return value;
		}
		if (/^file:/iu.test(value)) return undefined;
		const hash = value.indexOf('#');
		let path = hash < 0 ? value : value.slice(0, hash);
		let fragment = hash < 0 ? '' : value.slice(hash + 1);
		if (explicit) {
			if (path.includes('?')) return undefined;
			path = decodeURIComponent(path);
		} else {
			const suffix = /:(\d+)(?::(\d+))?$/u.exec(path);
			if (suffix) {
				path = path.slice(0, suffix.index);
				fragment = `L${suffix[1]},${suffix[2] ?? 1}`;
			}
			path = path.replaceAll('\\', '/');
		}
		if (!path || /[\\\u0000-\u001f]/u.test(path) || path.startsWith('//') || path.endsWith('/')) return undefined;
		const absolute = path.startsWith('/') || /^[a-z]:\//iu.test(path);
		if (!absolute && path.includes(':')) return undefined;
		const candidate = absolute
			? URI.joinPath(this.directory.resource.scheme === Schemas.file ? URI.file(path) : this.directory.resource.with({ path }), '.')
			: URI.joinPath(this.directory.resource, path);
		const target = candidate.with({ fragment });
		if ((hash >= 0 || fragment) && extractSelection(target).uri.fragment) return undefined;
		if (hash >= 0 && !fragment) return undefined;
		if ((!explicit || !absolute) && !extUri.isEqualOrParent(candidate, this.directory.resource)) return undefined;

		if (explicit || absolute || path.includes('/')) return await this.isFile(candidate) ? target.toString() : undefined;
		const found = await this.findUniqueBasename(path);
		return found?.with({ fragment }).toString();
	}

	private async isFile(resource: URI): Promise<boolean> {
		return !this.isDisposed && (await this.files.stat(resource)).kind === FileKind.File;
	}

	private findUniqueBasename(name: string): Promise<URI | undefined> {
		const previous = this.basenames.get(name);
		if (previous) return previous;
		const result = this.basenameSearch.then(async () => {
			if (this.isDisposed) return undefined;
			const search = await this.search.glob(this.directory, {
				includePatterns: [name, `**/${name}`], excludePatterns: ['.git', '**/.git/**'], maxResults: 2,
			}, this.cancellation.signal);
			if (search.totalMatches !== 1 || search.matches.length !== 1) return undefined;
			const resource = search.matches[0]!.resource;
			return basename(resource) === name && extUri.isEqualOrParent(resource, this.directory.resource) && await this.isFile(resource) ? resource : undefined;
		});
		this.basenames.set(name, result);
		this.basenameSearch = result.catch(() => undefined);
		return result;
	}

	protected override disposeCore(): void {
		this.cancellation.abort();
		super.disposeCore();
	}
}
