import './media/chatMarkdownPart.css';
import { chatMarkdownTableScrollClass, wrapTableWithScrollable } from './chatMarkdownTableScrolling.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { renderWorkbenchMarkdown, sanitizeMarkdownHtmlToFragment, type MarkdownRenderOptions } from '../../../../../../base/browser/markdownRenderer.js';
import { observeResize } from '../../../../../../base/browser/observer.js';
import { Dialog } from '../../../../../../base/browser/ui/dialog/dialog.js';
import type { ScrollableElement } from '../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import type { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { Marked } from '../../../../../../base/common/marked/marked.js';
import { equals } from '../../../../../../base/common/objects.js';
import { escapeRegExpCharacters, htmlAttributeEncodeValue } from '../../../../../../base/common/strings.js';
import { WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { openLinkFromMarkdown } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { resourceFileName, saveResourceAs } from '../../../../../services/files/browser/resourceSave.js';
import { MarkedKatexExtension } from '../../../../markdown/common/markedKatexExtension.js';
import { ChatContentMarkdownRenderer, getChatMarkdownRenderOptions } from '../chatContentMarkdownRenderer.js';
import { CHAT_RESPONSE_IMAGE_SCHEME, chatMarkdownRichContentExtension } from '../chatMarkdownRichContent.js';
import { IncrementalDOMMorpher, markdownFrameThreshold } from './chatIncrementalRendering/chatIncrementalRendering.js';
import type { FileSearchDirectory } from '../../../../../../platform/search/common/fileSearch.js';
import { ChatMarkdownFileReferences, isMarkdownFileReference } from './chatMarkdownFileReferences.js';
import { chatCitationButtonClass, ChatMarkdownDecorationsRenderer } from './chatMarkdownDecorationsRenderer.js';
import { canStartListCheckpoint, lexMarkdownTail, markdownTailCheckpoint, type MarkdownTailCheckpoint } from './chatMarkdownTail.js';
import { CodeBlockPart } from './codeBlockPart.js';
import type { ICodeBlockActionContext } from './codeBlockPart.js';
import { MarkdownDiffBlockPart, parseUnifiedDiff, parseUnifiedDiffFiles, type IMarkdownDiffBlockData } from './chatDiffBlockPart.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import type { ChatMarkdownRichContent } from '../../../common/model/chatMarkdownRichContent.js';
import type { IChatContentPart } from './chatContentParts.js';
import type { IChatCodeBlockInfo } from '../../chat.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { ChatImageGallery } from './chatImageGallery.js';
import { ChatMermaidRenderer, isClosedMermaidFence } from './chatMermaidRenderer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ImagePreviewPopup } from '../../../../mediaPreview/browser/imagePreviewPopup.js';
import { localize } from '../../../../../../nls.js';

interface RenderedBlock {
	node: ChildNode;
	readonly source: string;
	readonly reusable: boolean;
}

interface MarkdownTail {
	readonly raw: Element;
	readonly policy: string;
	readonly checkpoint?: MarkdownTailCheckpoint;
}

interface MarkdownTailPatch {
	readonly removed: readonly ChildNode[];
	readonly added: readonly ChildNode[];
}

const markdownTailThreshold = 4096;
const markdownSizeLimit = 4 * 1024 * 1024;

interface ChatResponseMarkdown extends IMarkdownString {
	readonly richContent?: ChatMarkdownRichContent;
}

/** Splitting changes the lexer scope. Keep raw HTML, references and math in a complete render. */
function canSplitRichMarkdown(source: string, content: ChatMarkdownRichContent): boolean {
	const markers = new RegExp(escapeRegExpCharacters(content.markerPrefix) + '(\\d+):>', 'gu');
	const local = (value: string) => !/[\r$\\]|\]:|(?:`{3}|~{3})[^\S\r\n]*math\b/u.test(value)
		&& !value.replace(markers, (marker, index: string) => content.parts[Number(index)] ? '' : marker).includes('<');
	return local(source) && content.parts.every(part => !('markdown' in part) || local(part.markdown));
}

function retainsRichParts(previous: ChatMarkdownRichContent | undefined, next: ChatMarkdownRichContent | undefined): boolean {
	return !previous || previous === next || previous.markerPrefix === next?.markerPrefix
		&& previous.parts.length <= next.parts.length && previous.parts.every((part, index) => equals(part, next.parts[index]));
}

// Streaming lists and pipe-led tables can start reusing rows as soon as
// rendering moves to the frame queue. Paragraphs keep the larger threshold.
function canPatchTail(source: string, allowEarlyList: boolean): boolean {
	return source.length >= markdownTailThreshold || source.length >= markdownFrameThreshold
		&& (source.startsWith('|') || allowEarlyList && canStartListCheckpoint(source));
}

interface MarkdownFragment {
	source: string;
	readonly element: HTMLElement;
	readonly lifetime: DisposableStore;
	readonly blocks: readonly RenderedBlock[];
	readonly images: ReadonlySet<string>;
	readonly codeStart: number;
	readonly codeCount: number;
	readonly tail?: MarkdownTail;
	incomplete: boolean;
	/** Only unindented, open, ordinary top-level fences can bypass Markdown parsing. */
	readonly fence?: { readonly headerLength: number; readonly closing: RegExp; readonly languageId: string; };
}

interface ChatMarkdownContentPartOptions extends MarkdownRenderOptions {
	readonly getChatItem?: () => IChatListItem | undefined;
	readonly readResponseImage?: (uri: URI, signal: AbortSignal) => Promise<Blob>;
	readonly ownerDocument: Document;
	readonly codeBlockPresentation?: 'card';
	readonly fileReferenceDirectory?: FileSearchDirectory;
	readonly markdown?: string | ChatResponseMarkdown;
	readonly visible?: boolean;
	/** The transcript admits new code documents after measuring their reserved row geometry. */
	readonly deferCodeBlockModels?: boolean;
	/** The virtual list measures a newly mounted row before returning from the scroll event. */
	readonly synchronousInitialRender?: boolean;
	readonly allowInlineDiffs?: boolean;
	readonly showContentActions?: boolean;
}

/** Owns one stable response root, sanitized render lifetime and the response's existing code models. */
export class ChatMarkdownContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;
	public readonly codeblocksPartId = `ash-chat-markdown-${createUuid()}`;
	private readonly markdownRenderer: ChatContentMarkdownRenderer;
	private readonly fileReferences?: ChatMarkdownFileReferences;
	private readonly decorations: ChatMarkdownDecorationsRenderer;
	private readonly incrementalRendering: IncrementalDOMMorpher<ChatResponseMarkdown>;
	private readonly renders = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly lexer = new Marked(MarkedKatexExtension.extension());
	private readonly plainLexer = new Marked();
	private readonly codeBlocks = this._register(new DisposableMap<number, CodeBlockPart | MarkdownDiffBlockPart>());
	private readonly images = new Map<string, Promise<Blob>>();
	private readonly responseImageController?: AbortController;
	private readonly galleries = new Set<ChatImageGallery>();
	private mermaid: ChatMermaidRenderer | undefined;
	private readonly inlineImagePreview = this._register(new MutableDisposable<DisposableStore & { readonly anchor: HTMLButtonElement; }>());
	private readonly tables = this._register(new DisposableMap<HTMLTableElement, DisposableStore>());
	private fragments: readonly MarkdownFragment[] = [];
	private markdown: ChatResponseMarkdown | undefined;
	// Code actions retain this response, rather than a full historical string per code block.
	private readonly codeElement: IMarkdownString;
	private readonly getCodeActionContext = (): Pick<ICodeBlockActionContext, 'element' | 'chatSessionResource'> => {
		const item = this.options.getChatItem?.();
		const source = this.options.codeBlockPresentation === 'card' && item?.transient ? undefined : item?.feedbackSource;
		return { element: item ?? this.codeElement, chatSessionResource: source ? LocalChatSessionUri.forSession(source.sessionId, source.threadId) : undefined };
	};
	private viewportVisible = true;
	private hasDeferredCodeBlocks = false;
	private readonly deferredCodeBlocks = new WeakSet<CodeBlockPart | MarkdownDiffBlockPart>();

	constructor(
		private readonly options: ChatMarkdownContentPartOptions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IOpenerService private readonly opener: IOpenerService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@ILayoutService private readonly layout: ILayoutService,
	) {
		super();
		if (options.readResponseImage) {
			const controller = this.responseImageController = new AbortController();
			this._register(toDisposable(() => controller.abort()));
		}
		this.markdownRenderer = this._register(instantiation.createInstance(ChatContentMarkdownRenderer));
		this.domNode = h(options.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-markdown-part ash-markdown';
		this.decorations = this._register(instantiation.createInstance(ChatMarkdownDecorationsRenderer, this.domNode, (href: string) => this.openMarkdownLink(href, this.codeElement)));
		if (options.fileReferenceDirectory) {
			this.fileReferences = this._register(instantiation.createInstance(ChatMarkdownFileReferences, this.domNode, options.fileReferenceDirectory, (anchor: HTMLAnchorElement) => {
				this.decorations.decorateLink(anchor);
				this.changedHeight.fire();
			}));
		}
		this.incrementalRendering = this._register(new IncrementalDOMMorpher<ChatResponseMarkdown>(this.domNode, options.visible ?? true, markdownSizeLimit, (markdown, incomplete, fromFrame) => {
			this.render(markdown, incomplete);
			if (fromFrame) {
				this.options.asyncRenderCallback?.();
				this.changedHeight.fire();
			}
		}));
		const part = this;
		this.codeElement = {
			get value() { return part.markdown?.value ?? ''; },
			get isTrusted() { return part.markdown?.isTrusted; },
			get supportHtml() { return part.markdown?.supportHtml; },
			get supportThemeIcons() { return part.markdown?.supportThemeIcons; },
			get supportAlertSyntax() { return part.markdown?.supportAlertSyntax; },
			get baseUri() { return part.markdown?.baseUri; },
		};
		this._register(addDisposableListener(this.domNode, 'load', event => { if ((event.target as Element).tagName === 'IMG') this.changedHeight.fire(); }, true));
		this._register(toDisposable(() => { this.images.clear(); this.fragments = []; this.markdown = undefined; this.domNode.remove(); }));
		const markdown = typeof options.markdown === 'string' ? { value: options.markdown } : options.markdown ?? { value: '' };
		this.incrementalRendering.update(markdown, options.fillInIncompleteTokens ?? false, !options.synchronousInitialRender);
	}

	/** Reconciles appended text and provider corrections within this response's existing lifetime. */
	public tryIncrementalUpdate(newMarkdown: ChatResponseMarkdown, fillInIncompleteTokens = false): boolean {
		if (this.isDisposed) return false;
		this.incrementalRendering.update(newMarkdown, fillInIncompleteTokens);
		return true;
	}

	/** Queues a snapshot only when it can be accepted without touching the live DOM. */
	public tryQueueIncrementalUpdate(markdown: ChatResponseMarkdown, incomplete: boolean): boolean {
		// Keep short corrections synchronous. Compare with the newest queued text
		// so a correction can replace an append that has not been painted yet.
		const previous = this.incrementalRendering.pending?.markdown ?? this.markdown;
		if (markdown.value.length < markdownFrameThreshold && (!previous?.value || !markdown.value.startsWith(previous.value))) return false;
		return !this.isDisposed && this.incrementalRendering.tryMorph(markdown, incomplete);
	}

	public get codeblocks(): readonly IChatCodeBlockInfo[] {
		if (this.isDisposed) { return []; }
		return [...this.codeBlocks].sort(([left], [right]) => left - right).map(([index, part]) => ({
			ownerMarkdownPartId: this.codeblocksPartId,
			codeBlockIndex: index,
			elementId: part.element.id,
			uri: part instanceof CodeBlockPart ? part.model?.uri : undefined,
			languageId: part instanceof CodeBlockPart ? part.model?.getLanguageId() : part.languageId,
			focus: () => { if (!this.isDisposed && this.incrementalRendering.isVisible) { part.focus(); } },
		}));
	}

	public hasSameContent(other: IChatListItem): boolean {
		const pending = this.incrementalRendering.pending;
		const markdown = pending?.markdown ?? this.markdown;
		const incomplete = pending?.incomplete ?? this.fragments.at(-1)?.incomplete ?? false;
		return !!markdown && markdown.value === other.text && incomplete === other.transient;
	}

	public setVisible(visible: boolean): void {
		this.incrementalRendering.setVisible(visible, !this.options.synchronousInitialRender || this.markdown !== undefined);
		for (const [, block] of this.codeBlocks) if (!this.deferredCodeBlocks.has(block)) block.setVisible(visible && this.viewportVisible);
		if (!visible) {
			this.inlineImagePreview.clear();
			for (const gallery of this.galleries) gallery.closePreviews();
		}
	}

	/** Retains readable Markdown while offscreen code blocks release their derived documents. */
	public setViewportVisible(visible: boolean): void {
		if (this.viewportVisible === visible && !this.hasDeferredCodeBlocks) return;
		this.viewportVisible = visible;
		this.hasDeferredCodeBlocks = false;
		for (const [, block] of this.codeBlocks) {
			this.deferredCodeBlocks.delete(block);
			block.setVisible(this.incrementalRendering.isVisible && visible);
		}
	}

	private render(markdown: ChatResponseMarkdown, fillInIncompleteTokens: boolean): void {
		const previous = this.markdown;
		const sameOptions = previous && previous.isTrusted === markdown.isTrusted && previous.supportHtml === markdown.supportHtml
			&& previous.supportThemeIcons === markdown.supportThemeIcons && previous.supportAlertSyntax === markdown.supportAlertSyntax
			&& previous.baseUri?.toString() === markdown.baseUri?.toString()
			&& retainsRichParts(previous.richContent, markdown.richContent);
		if (sameOptions && previous.value === markdown.value && previous.richContent?.parts.length === markdown.richContent?.parts.length
			&& this.fragments.at(-1)?.incomplete === fillInIncompleteTokens) return;
		const append = sameOptions && markdown.value.startsWith(previous.value);
		if (append && !markdown.richContent && this.extendFence(markdown, fillInIncompleteTokens)) { this.markdown = markdown; return; }
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
		let firstBlockEnd: number | undefined;
		const previousTail = this.fragments.at(-1);
		// Keep an established list checkpoint through completion. A one-shot
		// reply below the tail threshold has no future row updates to amortize it.
		const allowEarlyList = fillInIncompleteTokens || previousTail?.tail?.checkpoint?.kind === 'list';
		const ordinaryTail = sameOptions && canPatchTail(tail, allowEarlyList) && markdown.value.length <= markdownSizeLimit
			&& !markdown.richContent && !markdown.supportHtml && !this.options.markedExtensions?.length
			&& !/[$\\<>\r]|!\[|`{3}|~{3}|\]:/u.test(markdown.value)
			&& previousTail?.element.childElementCount === 1
			&& previousTail.element.firstElementChild!.matches(`p, ul, ol, .${chatMarkdownTableScrollClass}`);
		// An ordinary tail without a new blank line can go directly to the renderer.
		// It still verifies the block shape and handles incomplete inline syntax.
		if (ordinaryTail && !/\n[\t ]*\n/u.test(tail)) sources = [tail];
		// HTML and arbitrary extensions can carry state across blocks. Display math
		// may acquire a closing delimiter several paragraphs later; formulas also
		// share message-scoped macros. These inputs, reference definitions and
		// normalized CRLF offsets use the complete renderer.
		const richContent = markdown.richContent;
		if (!sources && (!markdown.supportHtml && !richContent || richContent && canSplitRichMarkdown(tail, richContent))
			&& !this.options.markedExtensions?.length && !tail.includes('\r')
			&& !tail.includes('$$') && !tail.includes('\\[') && markdown.value.length <= markdownSizeLimit) {
			// With no possible math opener, no extension scan or recursive math-token
			// walk is needed. A later delimiter still selects the full math path.
			const lexer = richContent ? new Marked(chatMarkdownRichContentExtension(richContent))
				: /[$\\]|`{3}|~{3}/u.test(tail) ? this.lexer : this.plainLexer;
			const options = { ...lexer.defaults, gfm: true, breaks: true, ...this.options.markedOptions };
			const checkpoint = ordinaryTail && append ? previousTail?.tail?.checkpoint : undefined;
			const resumed = checkpoint?.children && previousTail && tail.startsWith(previousTail.source)
				? lexMarkdownTail(tail, checkpoint, lexer, options) : undefined;
			const tokens = resumed?.tokens ?? lexer.lexer(tail, options);
			let hasMath = false;
			if (lexer === this.lexer) lexer.walkTokens(tokens, token => { if (token.type.startsWith('ashMath')) hasMath = true; });
			if (resumed || !hasMath && Object.keys(tokens.links).length === 0 && tokens.map(token => token.raw).join('') === tail) {
				firstBlockEnd = resumed?.firstBlockEnd;
				sources = [];
				let leading = resumed?.prefix ?? '';
				let contextLength = resumed?.contextLength ?? 0;
				for (const token of tokens) {
					if (token.type === 'space') {
						if (sources.length) sources[sources.length - 1] += token.raw;
						else leading += token.raw;
					} else {
						sources.push(leading + token.raw.slice(contextLength));
						leading = '';
						contextLength = 0;
					}
				}
				if (!sources.length) sources.push(leading);
			}
		}
		if (!sources) { retained.length = 0; sources = [markdown.value]; }
		const document = this.options.ownerDocument;
		const active = document.activeElement as HTMLElement | null;
		const focused = active && this.domNode.contains(active) ? active : undefined;
		const focusedDiffElement = focused?.closest('.ash-chat-markdown-diff');
		const focusedDiff = focusedDiffElement && [...this.codeBlocks].find(([, part]) => part.element === focusedDiffElement)?.[1];
		const originalDiffSide = Boolean(focused?.closest('.stanza-diff-editor-side.original'));
		const selection = document.getSelection();
		const selected = selection?.anchorNode && selection.focusNode && this.domNode.contains(selection.anchorNode) && this.domNode.contains(selection.focusNode)
			? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset } : undefined;
		const retired = this.fragments.slice(retained.length);
		const next = [...retained];
		const created: MarkdownFragment[] = [];
		const available = sameOptions ? [...retired] : [];
		let codeStart = retained.reduce((count, fragment) => count + fragment.codeCount, 0);
		let tailPatch: MarkdownTailPatch | undefined;
		try {
			for (const [index, source] of sources.entries()) {
				const incomplete = fillInIncompleteTokens && index === sources.length - 1;
				const match = available.findIndex(fragment => fragment.source === source && fragment.incomplete === incomplete
					&& (!fragment.codeCount || fragment.codeStart === codeStart));
				let fragment: MarkdownFragment;
				if (match >= 0) fragment = available.splice(match, 1)[0];
				else {
					const patchable = !richContent && canPatchTail(source, allowEarlyList);
					const replace = patchable ? available.findIndex(fragment => !fragment.codeCount && !fragment.images.size) : -1;
					const previous = replace >= 0 ? available.splice(replace, 1)[0] : undefined;
					const resumeEnd = append && previous === previousTail ? (index === 0 ? firstBlockEnd : undefined) ?? source.length : undefined;
					({ fragment, patch: tailPatch } = this.renderFragment({ ...markdown, value: source }, incomplete, codeStart, previous, resumeEnd, patchable));
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
				if (node) { block.node.replaceWith(node); block.node = node; }
			}
			this.renders.set(fragment.element, fragment.lifetime);
		}
		let node = this.domNode.firstChild;
		for (const fragment of next) {
			if (fragment.element !== node) this.domNode.insertBefore(fragment.element, node);
			node = fragment.element.nextSibling;
		}
		this.reconcileTables(created);
		for (const [index] of this.codeBlocks) if (index >= codeStart) this.codeBlocks.deleteAndDispose(index);
		this.fragments = next;
		this.markdown = markdown;
		// The usual append changes one tail in place. Structural updates can
		// also move stable blocks, so reconcile their bindings after insertion.
		if (tailPatch && created.length === 1 && retired.length === 1 && created[0].element === retired[0].element) {
			this.decorations.applyPatch(tailPatch.removed, tailPatch.added);
		} else {
			this.decorations.reconcile();
		}
		if (!fillInIncompleteTokens) this.fileReferences?.reconcile();
		const imageKeys = new Set(next.flatMap(fragment => [...fragment.images]));
		for (const key of this.images.keys()) if (!imageKeys.has(key)) this.images.delete(key);
		if (selected?.anchor.isConnected && selected.focus.isConnected) selection?.setBaseAndExtent(selected.anchor, selected.anchorOffset, selected.focus, selected.focusOffset);
		// Restoring a DOM range can focus the browser's editing host. Preserve toolbar focus.
		if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
		else if (!focused?.isConnected && focusedDiff instanceof MarkdownDiffBlockPart && focusedDiff.element.isConnected) focusedDiff.focus(originalDiffSide);
	}

	private renderFragment(markdown: ChatResponseMarkdown, incomplete: boolean, codeStart: number, previous: MarkdownFragment | undefined, resumeEnd: number | undefined, patchable: boolean): { fragment: MarkdownFragment; patch?: MarkdownTailPatch; } {
		const document = this.options.ownerDocument;
		// The content part owns the fragment root, which can outlive an individual render.
		const element = previous?.element ?? h(document, 'div');
		const lifetime = new DisposableStore();
		const code: { readonly languageId: string; readonly text: string; readonly placeholder: HTMLElement; readonly diagram: boolean; readonly diff?: IMarkdownDiffBlockData; }[] = [];
		const images = new Set<string>();
		try {
			const parts = markdown.richContent?.parts;
			const readResponseImage = this.options.readResponseImage;
			const hasInlineImages = !!readResponseImage && parts?.some(part => part.kind === 'image');
			const resolveResponseImage = (resource: URI) => {
				if (resource.authority || resource.query || resource.fragment || !/^(?:0|[1-9]\d*)$/u.test(resource.path)) return undefined;
				const part = parts?.[Number(resource.path)];
				return part?.kind === 'image' ? part : undefined;
			};
			const sanitizer = this.options.sanitizerConfig;
			const options: MarkdownRenderOptions = {
				...this.options, fillInIncompleteTokens: incomplete,
				markedExtensions: markdown.richContent ? [chatMarkdownRichContentExtension(markdown.richContent), ...(this.options.markedExtensions ?? [])] : this.options.markedExtensions,
				sanitizerConfig: hasInlineImages || this.fileReferences ? {
					...sanitizer,
					...(this.fileReferences && { deferLink: isMarkdownFileReference }),
					...(hasInlineImages && {
						allowedMediaSchemes: { augment: [...sanitizer?.allowedMediaSchemes?.augment ?? [], CHAT_RESPONSE_IMAGE_SCHEME] },
						remoteImageIsAllowed: (resource: URI) => resource.scheme === CHAT_RESPONSE_IMAGE_SCHEME
							? !!resolveResponseImage(resource) : sanitizer?.remoteImageIsAllowed?.(resource) ?? true,
					}),
				} : sanitizer,
				actionHandler: this.options.actionHandler ? href => this.options.actionHandler!(href, this.codeElement) : undefined,
				asyncRenderCallback: () => { this.options.asyncRenderCallback?.(); this.changedHeight.fire(); },
				imageResourceLoader: hasInlineImages || this.options.imageResourceLoader ? resource => {
					const responseImage = resource.scheme === CHAT_RESPONSE_IMAGE_SCHEME ? resolveResponseImage(resource) : undefined;
					const key = responseImage?.uri ?? resource.toString();
					images.add(key);
					let request = this.images.get(key);
					if (!request) {
						request = responseImage && readResponseImage
							? readResponseImage(URI.parse(responseImage.uri), this.responseImageController!.signal)
							: this.options.imageResourceLoader?.(resource) ?? Promise.reject(new Error('Unknown response image'));
						this.images.set(key, request);
					}
					return request;
				} : undefined,
				codeBlockRendererSync: (languageId, text, raw) => {
					const placeholder = h(document, 'div');
					placeholder.className = 'ash-chat-code-placeholder';
					const diffLanguage = this.options.allowInlineDiffs && !incomplete && /^diff:([\w+.-]+)$/u.exec(languageId)?.[1];
					let diff: IMarkdownDiffBlockData | undefined;
					if (diffLanguage) {
						const files = parseUnifiedDiffFiles(text, diffLanguage);
						if (files) {
							diff = { ...files[0], languageId: diffLanguage, source: text, files };
						} else {
							const { before, after } = parseUnifiedDiff(text);
							if (before !== after) diff = { languageId: diffLanguage, source: text, beforeContent: before, afterContent: after };
						}
					}
					code.push({ languageId, text, placeholder, diff, diagram: !incomplete && languageId === 'mermaid' && isClosedMermaidFence(raw) });
					return placeholder;
				},
			};
			const { tail, patch } = (patchable ? this.renderTail(markdown, options, element, previous, resumeEnd) : undefined) ?? {};
			if (tail) {
				lifetime.add(addDisposableListener<MouseEvent>(element, 'click', event => {
					const anchor = (event.target as Element | null)?.closest?.('a[href]');
					if (!anchor || !element.contains(anchor)) { return; }
					event.preventDefault();
					event.stopPropagation();
					const href = anchor.getAttribute('href')!;
					if (options.actionHandler) { options.actionHandler(href, markdown); }
					else { void openLinkFromMarkdown(this.opener, href, markdown.isTrusted); }
				}));
			} else {
				lifetime.add(this.markdownRenderer.render(markdown, options, element));
			}
			if (!patch) {
				this.enableInlineImagePreviews(element, lifetime);
				this.renderImageGalleries(element, lifetime, markdown.richContent);
				for (const rich of element.querySelectorAll<HTMLElement>('.ash-chat-rich')) {
					for (const variant of rich.classList) {
						const color = /^(background|border)-rgba-(\d{1,3})-(\d{1,3})-(\d{1,3})-([01](?:p\d+)?)$/u.exec(variant);
						if (!color) continue;
						const value = `rgba(${color[2]}, ${color[3]}, ${color[4]}, ${color[5].replace('p', '.')})`;
						if (color[1] === 'background') rich.style.backgroundColor = value;
						else rich.style.borderColor = value;
					}
				}
			}
			// Fingerprints belong to sanitized source before editor widgets or provider labels decorate it.
			const nodes = [...element.childNodes];
			// Async formula nodes belong to their render lifetime and cannot be transplanted after disposal.
			const fingerprints = nodes.map(node => ({
				// A reused target already reconciles its children. Do not serialize
				// its complete tree again for the separate whole-block reuse path.
				source: previous ? '' : node.nodeType === 1 ? (node as Element).outerHTML : node.textContent ?? '',
				reusable: !previous && (node.nodeType !== 1 || !(node as Element).matches('img,input,button,pre,.ash-katex-container') && !(node as Element).querySelector('img,input,button,.ash-chat-code-placeholder,.ash-katex-container')),
			}));
			for (const [localIndex, data] of code.entries()) {
				const index = codeStart + localIndex;
				let part = this.codeBlocks.get(index);
				if (!part || (part instanceof MarkdownDiffBlockPart) !== Boolean(data.diff)) {
					part = this.codeBlocks.set(index, data.diff
						? this.instantiation.createInstance(MarkdownDiffBlockPart, document, () => this.changedHeight.fire())
						: this.instantiation.createInstance(CodeBlockPart, document, this.options.codeBlockPresentation));
					part.element.id = `${this.codeblocksPartId}-${index}`;
					if (this.options.deferCodeBlockModels) {
						this.deferredCodeBlocks.add(part);
						this.hasDeferredCodeBlocks = true;
					}
				}
				part.setVisible(this.incrementalRendering.isVisible && this.viewportVisible && !this.deferredCodeBlocks.has(part));
				if (part instanceof MarkdownDiffBlockPart) {
					part.render(data.diff!);
				} else {
					part.render({ text: data.text, languageId: data.languageId, codeBlockIndex: index, element: this.codeElement, chatSessionResource: undefined, getActionContext: this.getCodeActionContext, renderOptions: { maxHeightInLines: 20 } });
				}
				const parent = data.placeholder.parentElement;
				let block = part.element;
				if (data.diagram) {
					this.mermaid ??= this._register(this.instantiation.createInstance(ChatMermaidRenderer));
					block = this.mermaid.render(data.text, block, lifetime, (image, previewLifetime) => this.enableInlineImagePreview(image, previewLifetime));
				}
				if (parent?.tagName === 'PRE') parent.replaceWith(block);
				else data.placeholder.replaceWith(block);
			}
			element.classList.remove('ash-markdown');
			element.classList.add('ash-chat-markdown-fragment');
			const blocks = [...element.childNodes].map((node, index) => ({ node, ...fingerprints[index] }));
			const header = /^(`{3,}|~{3,})([^\n]*)\n/u.exec(markdown.value);
			const closing = header ? new RegExp(`^ {0,3}${header[1][0]}{${header[1].length},}[\\t ]*(?:\\n|$)`, 'm') : undefined;
			const fence = !markdown.supportHtml && !this.options.markedExtensions?.length && !markdown.value.includes('\r')
				&& code.length === 1 && header && closing && !closing.test(markdown.value.slice(header[0].length))
				&& code[0].languageId !== 'math' && blocks.every(block => block.node === this.codeBlocks.get(codeStart)?.element
					|| block.node.nodeType === 3 && !block.node.textContent?.trim())
				? { headerLength: header[0].length, closing, languageId: code[0].languageId } : undefined;
			return { fragment: { source: markdown.value, element, lifetime, blocks, images, codeStart, codeCount: code.length, incomplete, fence, tail }, patch };
		} catch (error) {
			lifetime.dispose();
			throw error;
		}
	}

	private enableInlineImagePreviews(element: HTMLElement, lifetime: DisposableStore): void {
		for (const image of element.querySelectorAll<HTMLImageElement>('img')) {
			// Images used as links keep the author's link action. Resource images
			// receive their sanitized URL asynchronously from the Markdown renderer.
			if (image.closest('a, button')) continue;
			const ready = () => {
				if (!image.naturalWidth || !element.contains(image)) return;
				this.enableInlineImagePreview(image, lifetime);
			};
			if (image.complete && image.naturalWidth) ready();
			else lifetime.add(addDisposableListener(image, 'load', ready, { once: true }));
		}
	}

	private enableInlineImagePreview(image: HTMLImageElement, lifetime: DisposableStore): void {
		const document = image.ownerDocument;
		const name = image.alt || image.title || localize('chat.markdown.imageName', 'Image');
		const url = image.currentSrc || image.src;
		const readImage = isLocalImageSource(url) ? async (signal: AbortSignal) => {
			const response = await getWindow(image).fetch(url, { signal });
			if (!response.ok) throw new Error(response.statusText);
			return response.blob();
		} : undefined;
		const anchor = h(document, 'button', {
			className: 'ash-chat-media-preview-trigger',
			attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': localize('chat.markdown.previewImage', 'Preview {0}', name) },
		});
		image.replaceWith(anchor);
		anchor.append(image);
		let wrapper: HTMLElement | undefined;
		if (this.options.showContentActions && readImage) {
			const parent = anchor.parentElement!;
			if (!parent.classList.contains('ash-chat-rich-image')) {
				wrapper = h(document, 'span', { className: 'ash-chat-inline-image' });
				anchor.replaceWith(wrapper);
				wrapper.append(anchor);
			}
			this.mountContentActions(wrapper ?? parent, lifetime, {
				id: 'chat.markdown.downloadImage',
				label: localize('chat.resource.downloadFile', 'Download {0}', name),
				run: async signal => {
					const blob = await readImage(signal);
					await this.instantiation.invokeFunction(saveResourceAs, blob, resourceFileName(name, blob.type), document, { signal });
				},
			});
		}
		lifetime.add(addDisposableListener(anchor, 'click', () => {
			if (!url) return;
			const resources = Object.assign(new DisposableStore(), { anchor });
			this.inlineImagePreview.value = resources;
			anchor.focus({ preventScroll: true });
			const controller = new AbortController();
			resources.add(toDisposable(() => controller.abort()));
			void (async () => {
				const blob = await readImage?.(controller.signal).catch(() => undefined);
				if (resources.isDisposed) return;
				const preview = this.instantiation.createInstance(ImagePreviewPopup, { name, url, blob }, anchor, resources, undefined, () => {
					if (this.inlineImagePreview.value === resources) this.inlineImagePreview.clear();
				});
				if (!preview.show()) this.inlineImagePreview.clear();
			})().catch(error => {
				if (this.inlineImagePreview.value !== resources) return;
				this.inlineImagePreview.clear();
				this.notifications.error(String(error));
			});
		}));
		lifetime.add(toDisposable(() => {
			if (this.inlineImagePreview.value?.anchor === anchor) this.inlineImagePreview.clear();
			// A diagram can replace just its image when the theme changes.
			(wrapper ?? anchor).replaceWith(...anchor.childNodes);
		}));
	}

	private reconcileTables(created: readonly MarkdownFragment[]): void {
		// Tail patches retain the table, including its scroll position and actions.
		for (const [table] of this.tables) {
			if (!this.domNode.contains(table)) this.tables.deleteAndDispose(table);
		}
		for (const { element } of created) {
			for (const table of element.querySelectorAll('table')) {
				if (this.tables.has(table)) continue;
				const lifetime = this.tables.set(table, new DisposableStore());
				const scrollable = lifetime.add(wrapTableWithScrollable(table));
				if (this.options.showContentActions) this.mountTableActions(table, scrollable, lifetime);
			}
		}
	}

	private mountTableActions(table: HTMLTableElement, scrollable: ScrollableElement, lifetime: DisposableStore): void {
		const { toolbar, download } = this.mountContentActions(scrollable.element.parentElement!, lifetime, {
			id: 'chat.markdown.exportTable',
			label: localize({ bundle: 'ash.workbench', key: 'chat.markdown.exportTable' }, 'Export table as CSV'),
			toolbarLabel: localize({ bundle: 'ash.workbench', key: 'chat.markdown.tableActions' }, 'Table actions'),
			run: signal => {
				const rows = Array.from(table.rows, row => Array.from(row.cells, cell => '"' + cell.innerText.replaceAll('"', '""') + '"').join(','));
				const csv = new Blob([rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
				return this.instantiation.invokeFunction(saveResourceAs, csv, 'table.csv', table.ownerDocument, { signal });
			},
		});
		const preview = lifetime.add(new MutableDisposable<DisposableStore>());
		const label = localize({ bundle: 'ash.workbench', key: 'chat.markdown.expandTable' }, 'Expand table');
		const expand: IAction = {
			id: 'chat.markdown.expandTable', label, tooltip: label, icon: Lxicon.screenFull, enabled: true,
			run: async () => {
				if (preview.value || lifetime.isDisposed) return;
				const resources = preview.value = new DisposableStore();
				try {
					await this.showTablePreview(table, resources);
				} finally {
					preview.clear();
					if (!lifetime.isDisposed) updateActions();
				}
			},
		};
		let expandedActionVisible = false;
		const viewport = scrollable.scrollableElement;
		const updateActions = (): void => {
			// Keep the return-focus target while the dialog is open.
			if (preview.value || !viewport.clientWidth) return;
			const overflows = viewport.scrollWidth > viewport.clientWidth;
			if (overflows === expandedActionVisible) return;
			expandedActionVisible = overflows;
			toolbar.setActions(overflows ? [download, expand] : [download]);
			if (overflows) toolbar.element.querySelector('[data-action-id="chat.markdown.expandTable"] button')?.setAttribute('aria-haspopup', 'dialog');
		};
		lifetime.add(observeResize([viewport, scrollable.contentElement], updateActions));
	}

	private async showTablePreview(table: HTMLTableElement, resources: DisposableStore): Promise<void> {
		// Reuse the rendered Markdown cells, including their formatting and links.
		const markdown = this.markdown ?? this.codeElement;
		const snapshot = table.cloneNode(true) as HTMLTableElement;
		for (const wrapper of snapshot.querySelectorAll(`.${chatMarkdownTableScrollClass}`)) {
			const nested = wrapper.querySelector('table');
			if (nested) wrapper.replaceWith(nested);
		}
		for (const frame of snapshot.querySelectorAll('.ash-chat-content-actions-anchor')) {
			frame.querySelector(':scope > .ash-chat-content-actions')?.remove();
			frame.classList.remove('ash-chat-content-actions-anchor');
		}
		for (const button of snapshot.querySelectorAll(`button:not(.${chatCitationButtonClass})`)) button.replaceWith(...button.childNodes);
		for (const element of snapshot.querySelectorAll('[id]')) element.removeAttribute('id');
		snapshot.removeAttribute('id');
		const dialog = resources.add(new Dialog(this.layout.getContainer(getWindow(table)), localize({ bundle: 'ash.workbench', key: 'chat.markdown.tablePreview' }, 'Table preview'), undefined, {
			modal: false,
			layout: 'form',
			extraClasses: ['ash-chat-table-preview'],
			disableDefaultAction: true,
			buttonStyles: defaultButtonStyles,
			checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: { ...defaultDialogStyles, textLinkForeground: undefined },
			renderBody: body => {
				body.classList.add('ash-markdown');
				body.append(snapshot);
				resources.add(wrapTableWithScrollable(snapshot, 'both'));
				resources.add(this.decorations.bindCitations(snapshot));
				resources.add(addDisposableListener<MouseEvent>(snapshot, 'click', event => {
					const href = (event.target as Element | null)?.closest?.('a[href]')?.getAttribute('href');
					if (!href) return;
					event.preventDefault();
					event.stopPropagation();
					this.openMarkdownLink(href, markdown);
				}));
			},
		}));
		await dialog.show();
	}

	private openMarkdownLink(href: string, markdown: IMarkdownString): void {
		if (this.options.actionHandler) this.options.actionHandler(href, markdown);
		else void openLinkFromMarkdown(this.opener, href, markdown.isTrusted);
	}

	private mountContentActions(container: HTMLElement, lifetime: DisposableStore, options: {
		readonly id: string;
		readonly label: string;
		readonly toolbarLabel?: string;
		readonly run: (signal: AbortSignal) => Promise<void>;
	}): { toolbar: WorkbenchToolBar; download: IAction; } {
		const host = h(container.ownerDocument, 'div', { className: 'ash-chat-content-actions' });
		container.classList.add('ash-chat-content-actions-anchor');
		container.append(host);
		lifetime.add(toDisposable(() => {
			host.remove();
			container.classList.remove('ash-chat-content-actions-anchor');
		}));
		const controller = new AbortController();
		lifetime.add(toDisposable(() => controller.abort()));
		const toolbar = lifetime.add(new WorkbenchToolBar(host, this.contextMenus, { ariaLabel: options.toolbarLabel ?? options.label, tabNavigation: 'each-action' }));
		let running = false;
		const action: IAction = {
			id: options.id, label: options.label, tooltip: options.label, icon: Lxicon.download, enabled: true,
			run: async () => {
				if (running || controller.signal.aborted) return;
				running = true;
				host.setAttribute('aria-busy', 'true');
				try {
					await options.run(controller.signal);
				} finally {
					running = false;
					host.removeAttribute('aria-busy');
				}
			},
		};
		lifetime.add(toolbar.actionRunner.onDidRun(({ action: completedAction, error }) => {
			if (!error || controller.signal.aborted) return;
			if (completedAction === action) this.notifications.error(localize({ bundle: 'ash.workbench', key: 'chat.markdown.saveFailed' }, 'Could not save this content: {0}', String(error)));
			else this.notifications.error(String(error));
		}));
		toolbar.setActions([action]);
		return { toolbar, download: action };
	}

	private renderImageGalleries(element: HTMLElement, lifetime: DisposableStore, content: ChatMarkdownRichContent | undefined): void {
		const readImage = this.options.readResponseImage;
		if (!readImage) return;
		const parts = (content ?? this.options.getChatItem?.()?.markdown?.richContent)?.parts;
		for (const gallery of element.querySelectorAll<HTMLElement>('.ash-chat-image-gallery[data-ash-chat-gallery-index]')) {
			const part = parts?.[Number(gallery.dataset.ashChatGalleryIndex)];
			if (part?.kind !== 'imageGallery') continue;
			const widget = lifetime.add(this.instantiation.createInstance(ChatImageGallery, gallery, part.images, readImage, () => this.changedHeight.fire()));
			this.galleries.add(widget);
			lifetime.add(toDisposable(() => this.galleries.delete(widget)));
		}
	}

	/** Reuse sanitized children only within a fragment rendered with the same Markdown metadata and options. */
	private renderTail(markdown: IMarkdownString, options: MarkdownRenderOptions, element: HTMLElement, previous: MarkdownFragment | undefined, resumeEnd: number | undefined): { tail: MarkdownTail; patch?: MarkdownTailPatch; } | undefined {
		if (markdown.supportHtml || /[$\\<>]|!\[|`{3}|~{3}/u.test(markdown.value)
			|| options.transformUri || options.markedExtensions?.length
			|| options.sanitizerConfig?.allowedTags || options.sanitizerConfig?.allowedAttributes) {
			return undefined;
		}
		const document = element.ownerDocument;
		const renderOptions = getChatMarkdownRenderOptions(markdown.value, options);
		const template = document.createElement('template');
		const sanitizer = { ownerDocument: document, markdown, sanitizerConfig: renderOptions.sanitizerConfig };
		const policy = JSON.stringify([markdown.isTrusted, markdown.baseUri?.toString(), renderOptions.markedOptions, renderOptions.sanitizerConfig, !!renderOptions.markedExtensions?.length]);
		const parse = (value: string): Element | undefined => {
			template.innerHTML = renderWorkbenchMarkdown({ ...markdown, value }, false, renderOptions);
			const raw = template.content.firstElementChild;
			if (!raw || !['P', 'UL', 'OL', 'TABLE'].includes(raw.tagName) || markdown.value.length < markdownTailThreshold && raw.tagName === 'P'
				|| [...template.content.childNodes].some(node => node !== raw && (node.nodeType !== 3 || node.textContent?.trim()))
				|| [...raw.querySelectorAll('*')].some(node => !['P', 'LI', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'STRONG', 'EM', 'DEL', 'CODE', 'BR'].includes(node.tagName))) return undefined;
			return raw;
		};
		const oldTail = previous?.tail;
		const boundary = resumeEnd === undefined ? undefined : oldTail?.checkpoint;
		const lexerOptions = renderOptions.markedOptions ?? {};
		// The detached tree and the live DOM have the same checkpoint. Reparse
		// only the mutable suffix, and retain the preceding children in both.
		if (previous && oldTail?.policy === policy && boundary?.children && markdown.value.startsWith(previous.source)
			&& !/\]:|\r/u.test(markdown.value)) {
			// A proven sibling separator stays in the fragment's source for offset
			// tracking, but is outside the block that the checkpoint describes.
			const input = boundary.context + markdown.value.slice(boundary.offset, resumeEnd);
			const suffix = parse(input);
			if (suffix?.tagName === oldTail.raw.tagName) {
				const checkpoint = markdownTailCheckpoint(input, suffix, this.plainLexer, lexerOptions, boundary);
				if (checkpoint) {
					if (boundary.kind === 'paragraph') suffix.firstChild!.remove();
					const patch = patchTailChildren(element, oldTail.raw, suffix, sanitizer, boundary.children);
					if (patch) return { tail: { raw: oldTail.raw, policy, checkpoint }, patch };
				}
			}
		}

		const raw = parse(markdown.value);
		if (!raw) return undefined;
		const checkpoint = /\]:|\r/u.test(markdown.value) ? undefined : markdownTailCheckpoint(markdown.value, raw, this.plainLexer, lexerOptions);
		const tail = { raw, policy, checkpoint };
		if (oldTail?.policy === policy && oldTail.raw.tagName === raw.tagName && oldTail.raw.attributes.length === raw.attributes.length
			&& oldTail.raw.getAttributeNames().every(name => oldTail.raw.getAttribute(name) === raw.getAttribute(name))) {
			const patch = patchTailChildren(element, oldTail.raw, raw, sanitizer);
			if (patch) return { tail, patch };
		}
		element.replaceChildren(sanitizeMarkdownHtmlToFragment(sanitizer, template.innerHTML));
		return { tail };
	}

	private extendFence(markdown: IMarkdownString, incomplete: boolean): boolean {
		const fragment = this.fragments.at(-1);
		if (!fragment?.fence || markdown.value.length > markdownSizeLimit) return false;
		if (!incomplete && this.options.allowInlineDiffs && fragment.fence.languageId.startsWith('diff:')) return false;
		const part = this.codeBlocks.get(fragment.codeStart);
		if (!(part instanceof CodeBlockPart)) return false;
		const appended = markdown.value.slice(this.markdown!.value.length);
		if (appended.includes('\r')) return false;
		// A closing marker can span chunks, or cease being a closing marker when its
		// unfinished line receives more text. Re-lex that case instead of guessing.
		const lineStart = Math.max(fragment.fence.headerLength, fragment.source.lastIndexOf('\n') + 1);
		if (fragment.fence.closing.test(fragment.source.slice(lineStart) + appended)) return false;
		fragment.source += appended;
		fragment.incomplete = incomplete;
		part.render({
			text: fragment.source.slice(fragment.fence.headerLength).replace(/\n$/u, ''),
			languageId: fragment.fence.languageId, codeBlockIndex: fragment.codeStart,
			element: this.codeElement, chatSessionResource: undefined, getActionContext: this.getCodeActionContext, renderOptions: { maxHeightInLines: 20 },
		});
		return true;
	}
}

function isLocalImageSource(url: string): boolean {
	// Use bytes already admitted by Markdown rendering. No remote image requests
	// or screen captures are needed to save the original representation.
	return url.startsWith('blob:') || /^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(url);
}

function tailChildren(body: Element, start: number): ChildNode[] {
	const nodes: ChildNode[] = [];
	for (let node: ChildNode | null = body.childNodes.item(start); node; node = node.nextSibling) nodes.push(node);
	return nodes;
}

function changedTableCells(before: ChildNode | undefined, after: ChildNode | undefined, live: ChildNode | undefined): { before: HTMLTableCellElement; after: HTMLTableCellElement; }[] | undefined {
	if (before?.nodeName !== 'TR' || after?.nodeName !== 'TR' || live?.nodeName !== 'TR') return undefined;
	const oldRow = before as HTMLTableRowElement;
	const newRow = after as HTMLTableRowElement;
	const liveRow = live as HTMLTableRowElement;
	if (oldRow.attributes.length || newRow.attributes.length || oldRow.cells.length !== newRow.cells.length || oldRow.cells.length !== liveRow.cells.length) return undefined;
	const changed: { before: HTMLTableCellElement; after: HTMLTableCellElement; }[] = [];
	for (const [index, cell] of [...newRow.cells].entries()) {
		if (!cell.isEqualNode(oldRow.cells[index])) changed.push({ before: liveRow.cells[index], after: cell });
	}
	return changed.length ? changed : undefined;
}

function patchTailChildren(
	element: HTMLElement,
	old: Element,
	next: Element,
	sanitizer: Parameters<typeof sanitizeMarkdownHtmlToFragment>[0],
	committed = 0,
): MarkdownTailPatch | undefined {
	const table = next.tagName === 'TABLE';
	if (table && !old.firstElementChild?.isEqualNode(next.firstElementChild)) return undefined;
	const oldBody = table ? old.querySelector('tbody') : old;
	const newBody = table ? next.querySelector('tbody') : next;
	const block = element.firstElementChild;
	const body = table ? block?.querySelector('tbody') : block;
	if (!oldBody || !newBody || !body || oldBody.childNodes.length !== body.childNodes.length) return undefined;

	const source = (node: ChildNode): string => node.nodeType === 1 ? (node as Element).outerHTML : htmlAttributeEncodeValue(node.textContent ?? '');
	const before = tailChildren(oldBody, committed);
	const after = [...newBody.childNodes];
	const sharedLength = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < sharedLength && before[prefix].isEqualNode(after[prefix])) { prefix++; }
	if (prefix === before.length && prefix === after.length) return { removed: [], added: [] };
	let suffix = 0;
	while (suffix < sharedLength - prefix
		&& before[before.length - suffix - 1].isEqualNode(after[after.length - suffix - 1])) { suffix++; }

	const nodes = tailChildren(body, committed);
	const changed = after.slice(prefix, after.length - suffix);
	const cells = table && prefix < before.length - suffix ? changedTableCells(before[prefix], changed[0], nodes[prefix]) : undefined;
	// Keep the mutable row in place when its columns still match. Sanitize
	// changed cells and new rows together in the usual table context.
	const html = cells ? `<tr>${cells.map(cell => cell.after.outerHTML).join('')}</tr>` + changed.slice(1).map(source).join('') : changed.map(source).join('');
	const tag = newBody.tagName.toLowerCase();
	const wrapped = table ? `<table><tbody>${html}</tbody></table>` : `<${tag}>${html}</${tag}>`;
	const sanitized = sanitizeMarkdownHtmlToFragment(sanitizer, wrapped);
	const replacement = table ? sanitized.querySelector('tbody')! : sanitized.firstElementChild!;
	const added = [...replacement.childNodes];
	const anchor = nodes[nodes.length - suffix] ?? null;
	const removed = nodes.slice(prefix + (cells ? 1 : 0), nodes.length - suffix);
	let replacedCells: HTMLTableCellElement[] = [];
	if (cells) {
		const row = added.shift() as HTMLTableRowElement | undefined;
		if (row?.nodeName !== 'TR' || row.cells.length !== cells.length) return undefined;
		replacedCells = [...row.cells];
		for (const [index, cell] of cells.entries()) cell.before.replaceWith(replacedCells[index]);
	}
	for (const node of removed) { node.remove(); }
	for (const node of added) { body.insertBefore(node, anchor); }
	if (committed) {
		const rawAnchor = before[before.length - suffix] ?? null;
		for (const node of before.slice(prefix, before.length - suffix)) { node.remove(); }
		for (const node of changed) { oldBody.insertBefore(node, rawAnchor); }
	}
	return cells ? { removed: [...cells.map(cell => cell.before), ...removed], added: [...replacedCells, ...added] } : { removed, added };
}
