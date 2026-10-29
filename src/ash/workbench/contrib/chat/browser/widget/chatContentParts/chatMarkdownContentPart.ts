import './media/chatMarkdownPart.css';
import { Emitter } from '../../../../../../base/common/event.js';
import { addDisposableListener, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../../../base/browser/dom.js';
import type { MarkdownRenderOptions } from '../../../../../../base/browser/markdownRenderer.js';
import type { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Marked } from '../../../../../../base/common/marked/marked.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { MarkedKatexExtension } from '../../../../markdown/common/markedKatexExtension.js';
import { ChatContentMarkdownRenderer } from '../chatContentMarkdownRenderer.js';
import { ChatMarkdownDecorationsRenderer } from './chatMarkdownDecorationsRenderer.js';
import { CodeBlockPart } from './codeBlockPart.js';

interface RenderedBlock {
	node: ChildNode;
	readonly source: string;
	readonly reusable: boolean;
}

interface MarkdownFragment {
	source: string;
	readonly element: HTMLElement;
	readonly lifetime: DisposableStore;
	readonly blocks: readonly RenderedBlock[];
	readonly images: ReadonlySet<string>;
	readonly codeStart: number;
	readonly codeCount: number;
	incomplete: boolean;
	/** Only unindented, open, ordinary top-level fences can bypass Markdown parsing. */
	readonly fence?: { readonly headerLength: number; readonly closing: RegExp; readonly languageId: string };
}

interface ChatMarkdownContentPartOptions extends MarkdownRenderOptions {
	readonly ownerDocument: Document;
	readonly markdown?: string | IMarkdownString;
	readonly visible?: boolean;
	/** The transcript admits new code documents after measuring their reserved row geometry. */
	readonly deferCodeBlockModels?: boolean;
}

/** Owns one stable response root, sanitized render lifetime and the response's existing code models. */
export class ChatMarkdownContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;
	private readonly markdownRenderer: ChatContentMarkdownRenderer;
	private readonly renders = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly lexer = new Marked(MarkedKatexExtension.extension());
	private readonly plainLexer = new Marked();
	private readonly codeBlocks = this._register(new DisposableMap<number, CodeBlockPart>());
	private readonly images = new Map<string, Promise<Blob>>();
	private fragments: readonly MarkdownFragment[] = [];
	private markdown: IMarkdownString | undefined;
	// Code actions retain this response, rather than a full historical string per code block.
	private readonly codeElement: IMarkdownString;
	private visible: boolean;
	private viewportVisible = true;
	private hasDeferredCodeBlocks = false;
	private readonly deferredCodeBlocks = new WeakSet<CodeBlockPart>();
	private pending: { readonly markdown: IMarkdownString; readonly incomplete: boolean } | undefined;
	private readonly update = this._register(new MutableDisposable());

	constructor(
		private readonly options: ChatMarkdownContentPartOptions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.visible = options.visible ?? true;
		this.markdownRenderer = this._register(instantiation.createInstance(ChatContentMarkdownRenderer));
		this.domNode = h(options.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-markdown-part ash-markdown';
		const part = this;
		this.codeElement = {
			get value() {
				return part.markdown?.value ?? '';
			},
			get isTrusted() {
				return part.markdown?.isTrusted;
			},
			get supportHtml() {
				return part.markdown?.supportHtml;
			},
			get supportThemeIcons() {
				return part.markdown?.supportThemeIcons;
			},
			get supportAlertSyntax() {
				return part.markdown?.supportAlertSyntax;
			},
			get baseUri() {
				return part.markdown?.baseUri;
			},
		};
		this._register(
			addDisposableListener(
				this.domNode,
				'load',
				event => {
					if ((event.target as Element).tagName === 'IMG') this.changedHeight.fire();
				},
				true,
			),
		);
		this._register(
			toDisposable(() => {
				this.images.clear();
				this.fragments = [];
				this.markdown = undefined;
				this.pending = undefined;
				this.domNode.remove();
			}),
		);
		const markdown = typeof options.markdown === 'string' ? { value: options.markdown } : (options.markdown ?? { value: '' });
		this.enqueue(markdown, options.fillInIncompleteTokens ?? false);
	}

	/** Reconciles appended text and provider corrections within this response's existing lifetime. */
	public tryIncrementalUpdate(newMarkdown: IMarkdownString, fillInIncompleteTokens = false): boolean {
		if (this.isDisposed) return false;
		this.enqueue(newMarkdown, fillInIncompleteTokens);
		return true;
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) this.update.clear();
		else if (this.pending) {
			const pending = this.pending;
			this.pending = undefined;
			// Preserve synchronous first-show for small responses; large snapshots
			// still share the ordinary frame-coalesced rendering path.
			this.enqueue(pending.markdown, pending.incomplete);
		}
		for (const [, block] of this.codeBlocks) if (!this.deferredCodeBlocks.has(block)) block.setVisible(visible && this.viewportVisible);
	}

	/** Retains readable Markdown while offscreen code blocks release their derived documents. */
	public setViewportVisible(visible: boolean): void {
		if (this.viewportVisible === visible && !this.hasDeferredCodeBlocks) return;
		this.viewportVisible = visible;
		this.hasDeferredCodeBlocks = false;
		for (const [, block] of this.codeBlocks) {
			this.deferredCodeBlocks.delete(block);
			block.setVisible(this.visible && visible);
		}
	}

	private enqueue(markdown: IMarkdownString, incomplete: boolean): void {
		// Preserve the complete renderer's synchronous admission/size error.
		if (markdown.value.length > 4 * 1024 * 1024) {
			this.render(markdown, incomplete);
			return;
		}
		if (!this.visible) {
			this.update.clear();
			this.pending = { markdown, incomplete };
			return;
		}
		if (markdown.value.length < 1024) {
			this.update.clear();
			this.pending = undefined;
			this.render(markdown, incomplete);
			return;
		}
		// The transcript owns every source snapshot. Rendering consumes only the
		// latest one per frame; terminal updates and corrections use the same slot.
		this.pending = { markdown, incomplete };
		if (this.visible) this.scheduleUpdate();
	}

	private scheduleUpdate(): void {
		if (this.update.value) return;
		this.update.value = scheduleAtNextAnimationFrame(getWindow(this.domNode), () => {
			this.update.clear();
			const pending = this.pending;
			this.pending = undefined;
			if (!pending) return;
			this.render(pending.markdown, pending.incomplete);
			this.options.asyncRenderCallback?.();
			this.changedHeight.fire();
		});
	}

	private render(markdown: IMarkdownString, fillInIncompleteTokens: boolean): void {
		const previous = this.markdown;
		const sameOptions =
			previous &&
			previous.isTrusted === markdown.isTrusted &&
			previous.supportHtml === markdown.supportHtml &&
			previous.supportThemeIcons === markdown.supportThemeIcons &&
			previous.supportAlertSyntax === markdown.supportAlertSyntax &&
			previous.baseUri?.toString() === markdown.baseUri?.toString();
		if (sameOptions && previous.value === markdown.value && this.fragments.at(-1)?.incomplete === fillInIncompleteTokens) return;
		const append = sameOptions && markdown.value.startsWith(previous.value);
		if (append && this.extendFence(markdown, fillInIncompleteTokens)) {
			this.markdown = markdown;
			return;
		}
		const retained: MarkdownFragment[] = [];
		let offset = 0;
		if (sameOptions) {
			// Keep the last block mutable even after blank lines: lists, indented code,
			// setext headings and tables can absorb later input. Corrections invalidate
			// from the first changed block, while unchanged blocks can keep their DOM.
			for (const fragment of this.fragments.slice(0, -1)) {
				if (!append && !markdown.value.startsWith(fragment.source, offset)) break;
				retained.push(fragment);
				offset += fragment.source.length;
			}
			// A correction can turn the next paragraph into an indented list/code
			// continuation. Reconsider its preceding block even if that source is unchanged.
			if (!append && retained.length) offset -= retained.pop()!.source.length;
		}
		const tail = markdown.value.slice(offset);
		let sources: string[] | undefined;
		const previousTail = this.fragments.at(-1);
		// A single ordinary block without a new blank line has no block boundary
		// to discover. Its canonical renderer still parses the complete current
		// source, including incomplete inline syntax; avoid a second full lexer pass.
		if (
			sameOptions &&
			tail.length >= 4096 &&
			markdown.value.length <= 4 * 1024 * 1024 &&
			!markdown.supportHtml &&
			!this.options.markedExtensions?.length &&
			!/[$\\<>\r]|!\[|`{3}|~{3}|\]:/u.test(markdown.value) &&
			!/\n[\t ]*\n/u.test(tail) &&
			previousTail?.element.childElementCount === 1 &&
			['P', 'UL', 'OL', 'TABLE'].includes(previousTail.element.firstElementChild!.tagName)
		)
			sources = [tail];
		// HTML and arbitrary extensions can carry state across blocks. Display math
		// may acquire a closing delimiter several paragraphs later; formulas also
		// share message-scoped macros. These inputs, reference definitions and
		// normalized CRLF offsets use the complete renderer.
		if (
			!sources &&
			!markdown.supportHtml &&
			!this.options.markedExtensions?.length &&
			!tail.includes('\r') &&
			!tail.includes('$$') &&
			!tail.includes('\\[') &&
			markdown.value.length <= 4 * 1024 * 1024
		) {
			// With no possible math opener, no extension scan or recursive math-token
			// walk is needed. A later delimiter still selects the full math path.
			const lexer = /[$\\]|`{3}|~{3}/u.test(tail) ? this.lexer : this.plainLexer;
			const tokens = lexer.lexer(tail, {
				...lexer.defaults,
				gfm: true,
				breaks: true,
				...this.options.markedOptions,
			});
			let hasMath = false;
			if (lexer === this.lexer)
				lexer.walkTokens(tokens, token => {
					if (token.type.startsWith('ashMath')) hasMath = true;
				});
			if (!hasMath && Object.keys(tokens.links).length === 0 && tokens.map(token => token.raw).join('') === tail) {
				sources = [];
				let leading = '';
				for (const token of tokens) {
					if (token.type === 'space') {
						if (sources.length) sources[sources.length - 1] += token.raw;
						else leading += token.raw;
					} else {
						sources.push(leading + token.raw);
						leading = '';
					}
				}
				if (!sources.length) sources.push(leading);
			}
		}
		if (!sources) {
			retained.length = 0;
			sources = [markdown.value];
		}
		const document = this.options.ownerDocument;
		const active = document.activeElement as HTMLElement | null;
		const focused = active && this.domNode.contains(active) ? active : undefined;
		const selection = document.getSelection();
		const selected =
			selection?.anchorNode && selection.focusNode && this.domNode.contains(selection.anchorNode) && this.domNode.contains(selection.focusNode)
				? {
						anchor: selection.anchorNode,
						anchorOffset: selection.anchorOffset,
						focus: selection.focusNode,
						focusOffset: selection.focusOffset,
					}
				: undefined;
		const retired = this.fragments.slice(retained.length);
		const next = [...retained];
		const created: MarkdownFragment[] = [];
		const available = sameOptions ? [...retired] : [];
		const targets = new Set<HTMLElement>();
		let codeStart = retained.reduce((count, fragment) => count + fragment.codeCount, 0);
		try {
			for (const [index, source] of sources.entries()) {
				const incomplete = fillInIncompleteTokens && index === sources.length - 1;
				const match = available.findIndex(fragment => fragment.source === source && fragment.incomplete === incomplete && (!fragment.codeCount || fragment.codeStart === codeStart));
				let fragment: MarkdownFragment;
				if (match >= 0) fragment = available.splice(match, 1)[0];
				else {
					const target = source.length >= 4096 ? available.find(fragment => !fragment.codeCount && !fragment.images.size && !targets.has(fragment.element))?.element : undefined;
					if (target) targets.add(target);
					fragment = this.renderFragment({ ...markdown, value: source }, incomplete, codeStart, target);
					created.push(fragment);
				}
				next.push(fragment);
				codeStart += fragment.codeCount;
			}
		} catch (error) {
			for (const fragment of created) fragment.lifetime.dispose();
			throw error;
		}
		const reused = new Set(next);
		const reusable = new Map<string, ChildNode[]>();
		for (const fragment of retired) {
			if (reused.has(fragment)) continue;
			for (const block of fragment.blocks) {
				if (!block.reusable || !sameOptions) continue;
				const matches = reusable.get(block.source) ?? [];
				matches.push(block.node);
				reusable.set(block.source, matches);
			}
			// New math/image consumers exist before old renders are retired.
			this.renders.deleteAndDispose(fragment.element);
			if (!created.some(next => next.element === fragment.element)) fragment.element.remove();
		}
		for (const fragment of created) {
			for (const block of fragment.blocks) {
				const node = block.reusable ? reusable.get(block.source)?.shift() : undefined;
				if (node) {
					block.node.replaceWith(node);
					block.node = node;
				}
			}
			fragment.lifetime.add(this.instantiation.createInstance(ChatMarkdownDecorationsRenderer, fragment.element));
			this.renders.set(fragment.element, fragment.lifetime);
		}
		let node = this.domNode.firstChild;
		for (const fragment of next) {
			if (fragment.element !== node) this.domNode.insertBefore(fragment.element, node);
			node = fragment.element.nextSibling;
		}
		for (const [index] of this.codeBlocks) if (index >= codeStart) this.codeBlocks.deleteAndDispose(index);
		this.fragments = next;
		this.markdown = markdown;
		const imageKeys = new Set(next.flatMap(fragment => [...fragment.images]));
		for (const key of this.images.keys()) if (!imageKeys.has(key)) this.images.delete(key);
		if (selected?.anchor.isConnected && selected.focus.isConnected) selection?.setBaseAndExtent(selected.anchor, selected.anchorOffset, selected.focus, selected.focusOffset);
		// Restoring a DOM range can focus the browser's editing host. Preserve toolbar focus.
		if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
	}

	private renderFragment(markdown: IMarkdownString, incomplete: boolean, codeStart: number, target?: HTMLElement): MarkdownFragment {
		const document = this.options.ownerDocument;
		const lifetime = new DisposableStore();
		const code: { readonly languageId: string; readonly text: string; readonly placeholder: HTMLElement }[] = [];
		const images = new Set<string>();
		try {
			const rendered = lifetime.add(
				this.markdownRenderer.render(
					markdown,
					{
						...this.options,
						fillInIncompleteTokens: incomplete,
						actionHandler: this.options.actionHandler ? href => this.options.actionHandler!(href, this.codeElement) : undefined,
						asyncRenderCallback: () => {
							this.options.asyncRenderCallback?.();
							this.changedHeight.fire();
						},
						imageResourceLoader: this.options.imageResourceLoader
							? resource => {
									const key = resource.toString();
									images.add(key);
									let request = this.images.get(key);
									if (!request) {
										request = this.options.imageResourceLoader!(resource);
										this.images.set(key, request);
									}
									return request;
								}
							: undefined,
						codeBlockRendererSync: (languageId, text) => {
							const placeholder = h(document, 'div');
							placeholder.className = 'ash-chat-code-placeholder';
							code.push({ languageId, text, placeholder });
							return placeholder;
						},
					},
					target,
				),
			);
			// Fingerprints belong to sanitized source before editor widgets or provider labels decorate it.
			const nodes = [...rendered.element.childNodes];
			// Async formula nodes belong to their render lifetime and cannot be transplanted after disposal.
			const fingerprints = nodes.map(node => ({
				// A reused target already reconciles its children. Do not serialize
				// its complete tree again for the separate whole-block reuse path.
				source: target ? '' : node.nodeType === 1 ? (node as Element).outerHTML : (node.textContent ?? ''),
				reusable:
					!target &&
					(node.nodeType !== 1 ||
						(!(node as Element).matches('img,input,button,pre,.ash-katex-container') &&
							!(node as Element).querySelector('img,input,button,.ash-chat-code-placeholder,.ash-katex-container'))),
			}));
			for (const [localIndex, data] of code.entries()) {
				const index = codeStart + localIndex;
				let part = this.codeBlocks.get(index);
				if (!part) {
					part = this.codeBlocks.set(index, this.instantiation.createInstance(CodeBlockPart, document));
					if (this.options.deferCodeBlockModels) {
						this.deferredCodeBlocks.add(part);
						this.hasDeferredCodeBlocks = true;
					}
				}
				part.setVisible(this.visible && this.viewportVisible && !this.deferredCodeBlocks.has(part));
				part.render(
					{
						text: data.text,
						languageId: data.languageId,
						codeBlockIndex: index,
						element: this.codeElement,
						chatSessionResource: undefined,
						renderOptions: { maxHeightInLines: 20 },
					},
					this.domNode.clientWidth,
				);
				const parent = data.placeholder.parentElement;
				if (parent?.tagName === 'PRE') parent.replaceWith(part.element);
				else data.placeholder.replaceWith(part.element);
			}
			rendered.element.classList.remove('ash-markdown');
			rendered.element.classList.add('ash-chat-markdown-fragment');
			const blocks = [...rendered.element.childNodes].map((node, index) => ({ node, ...fingerprints[index] }));
			const header = /^(`{3,}|~{3,})([^\n]*)\n/u.exec(markdown.value);
			const closing = header ? new RegExp(`^ {0,3}${header[1][0]}{${header[1].length},}[\\t ]*(?:\\n|$)`, 'm') : undefined;
			const fence =
				!markdown.supportHtml &&
				!this.options.markedExtensions?.length &&
				!markdown.value.includes('\r') &&
				code.length === 1 &&
				header &&
				closing &&
				!closing.test(markdown.value.slice(header[0].length)) &&
				code[0].languageId !== 'math' &&
				blocks.every(block => block.node === this.codeBlocks.get(codeStart)?.element || (block.node.nodeType === 3 && !block.node.textContent?.trim()))
					? { headerLength: header[0].length, closing, languageId: code[0].languageId }
					: undefined;
			return {
				source: markdown.value,
				element: rendered.element,
				lifetime,
				blocks,
				images,
				codeStart,
				codeCount: code.length,
				incomplete,
				fence,
			};
		} catch (error) {
			lifetime.dispose();
			throw error;
		}
	}

	private extendFence(markdown: IMarkdownString, incomplete: boolean): boolean {
		const fragment = this.fragments.at(-1);
		if (!fragment?.fence || markdown.value.length > 4 * 1024 * 1024) return false;
		const appended = markdown.value.slice(this.markdown!.value.length);
		if (appended.includes('\r')) return false;
		// A closing marker can span chunks, or cease being a closing marker when its
		// unfinished line receives more text. Re-lex that case instead of guessing.
		const lineStart = Math.max(fragment.fence.headerLength, fragment.source.lastIndexOf('\n') + 1);
		if (fragment.fence.closing.test(fragment.source.slice(lineStart) + appended)) return false;
		fragment.source += appended;
		fragment.incomplete = incomplete;
		this.codeBlocks.get(fragment.codeStart)!.render(
			{
				text: fragment.source.slice(fragment.fence.headerLength).replace(/\n$/u, ''),
				languageId: fragment.fence.languageId,
				codeBlockIndex: fragment.codeStart,
				element: this.codeElement,
				chatSessionResource: undefined,
				renderOptions: { maxHeightInLines: 20 },
			},
			this.domNode.clientWidth,
		);
		return true;
	}
}
