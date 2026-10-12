import './media/chatMarkdownPart.css';
import { h } from '../../../../../../base/browser/dom.js';
import { MarkdownElement, type MarkdownElementOptions } from '../../../../../../base/browser/markdownRenderer.js';
import type { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatMarkdownDecorationsRenderer } from './chatMarkdownDecorationsRenderer.js';
import { CodeBlockPart } from './codeBlockPart.js';

interface RenderedBlock {
	readonly node: ChildNode;
	readonly source: string;
	readonly reusable: boolean;
}

/** Owns one stable response root, sanitized render lifetime and the response's existing code models. */
export class ChatMarkdownContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private readonly codeBlocks = this._register(new DisposableMap<number, CodeBlockPart>());
	private readonly images = new Map<string, Promise<Blob>>();
	private blocks: readonly RenderedBlock[] = [];
	private source = '';

	constructor(private readonly options: MarkdownElementOptions, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.domNode = h(options.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-markdown-part';
		this._register(toDisposable(() => { this.images.clear(); this.blocks = []; this.domNode.remove(); }));
		const markdown = typeof options.markdown === 'string' ? { value: options.markdown } : options.markdown ?? { value: '' };
		this.render(markdown, options.fillInIncompleteTokens ?? false);
	}

	/** Accepts only an append to this response; the list replaces the part for rewritten content. */
	public tryIncrementalUpdate(newMarkdown: IMarkdownString, fillInIncompleteTokens = false): boolean {
		if (!newMarkdown.value.startsWith(this.source)) return false;
		this.render(newMarkdown, fillInIncompleteTokens);
		return true;
	}

	private render(markdown: IMarkdownString, fillInIncompleteTokens: boolean): void {
		const document = this.options.ownerDocument;
		const active = document.activeElement as HTMLElement | null;
		const focused = active && this.domNode.contains(active) ? active : undefined;
		const selection = document.getSelection();
		const selected = selection?.anchorNode && selection.focusNode && this.domNode.contains(selection.anchorNode) && this.domNode.contains(selection.focusNode)
			? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset } : undefined;
		const lifetime = new DisposableStore();
		const code: { readonly languageId: string; readonly text: string; readonly placeholder: HTMLElement; }[] = [];
		const images = new Set<string>();
		try {
			const rendered = lifetime.add(new MarkdownElement({
				...this.options, markdown, fillInIncompleteTokens,
				imageResourceLoader: this.options.imageResourceLoader ? resource => {
					const key = resource.toString();
					images.add(key);
					let request = this.images.get(key);
					if (!request) { request = this.options.imageResourceLoader!(resource); this.images.set(key, request); }
					return request;
				} : undefined,
				codeBlockRendererSync: (languageId, text) => {
					const placeholder = h(document, 'div');
					placeholder.className = 'ash-chat-code-placeholder';
					code.push({ languageId, text, placeholder });
					return placeholder;
				},
			}));
			// Fingerprints belong to sanitized source before editor widgets or provider labels decorate it.
			const nodes = [...rendered.element.childNodes];
			const fingerprints = nodes.map(node => ({
				source: node.nodeType === 1 ? (node as Element).outerHTML : node.textContent ?? '',
				reusable: node.nodeType !== 1 || !(node as Element).matches('img,input,button,pre') && !(node as Element).querySelector('img,input,button,.ash-chat-code-placeholder'),
			}));
			this.current.clear();
			for (const [index, node] of nodes.entries()) {
				const previous = this.blocks[index];
				if (previous?.reusable && fingerprints[index].reusable && previous.source === fingerprints[index].source) node.parentNode?.replaceChild(previous.node, node);
			}
			for (const [index, data] of code.entries()) {
				let part = this.codeBlocks.get(index);
				if (!part) part = this.codeBlocks.set(index, this.instantiation.createInstance(CodeBlockPart, document));
				part.render({ text: data.text, languageId: data.languageId, codeBlockIndex: index, element: markdown, chatSessionResource: undefined, renderOptions: { maxHeightInLines: 20 } }, this.domNode.clientWidth);
				const parent = data.placeholder.parentElement;
				if (parent?.tagName === 'PRE') parent.replaceWith(part.element);
				else data.placeholder.replaceWith(part.element);
			}
			for (const [index] of this.codeBlocks) if (index >= code.length) this.codeBlocks.deleteAndDispose(index);
			this.domNode.replaceChildren(rendered.element);
			this.blocks = [...rendered.element.childNodes].map((node, index) => ({ node, ...fingerprints[index] }));
			for (const key of this.images.keys()) if (!images.has(key)) this.images.delete(key);
			lifetime.add(this.instantiation.createInstance(ChatMarkdownDecorationsRenderer, rendered.element));
			this.current.value = lifetime;
			this.source = markdown.value;
			if (focused?.isConnected) focused.focus({ preventScroll: true });
			if (selected?.anchor.isConnected && selected.focus.isConnected) selection?.setBaseAndExtent(selected.anchor, selected.anchorOffset, selected.focus, selected.focusOffset);
		} catch (error) {
			lifetime.dispose();
			throw error;
		}
	}
}
