import './media/chatMarkdownPart.css';
import { MarkdownElement, type MarkdownElementOptions } from '../../../../../../base/browser/markdownRenderer.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatMarkdownDecorationsRenderer } from './chatMarkdownDecorationsRenderer.js';
import { CodeBlockPart } from './codeBlockPart.js';

/** Owns sanitized response Markdown and its live provider decorations for one transcript row. */
export class ChatMarkdownContentPart extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(options: MarkdownElementOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		const codeBlocks: CodeBlockPart[] = [];
		const markdown = this._register(new MarkdownElement({
			...options,
			codeBlockRendererSync: (languageId, text) => {
				const part = this._register(instantiationService.createInstance(CodeBlockPart, options.ownerDocument));
				part.render({
					text, languageId, codeBlockIndex: codeBlocks.length, element: options.markdown,
					chatSessionResource: undefined, renderOptions: { maxHeightInLines: 20 },
				}, 0);
				codeBlocks.push(part);
				return part.element;
			},
		}));
		this.domNode = markdown.element;
		this.domNode.classList.add('ash-chat-markdown-part');
		// The base renderer targets <code>; a full editor must replace its enclosing <pre> as well.
		for (const part of codeBlocks) {
			if (part.element.parentElement?.tagName === 'PRE') part.element.parentElement.replaceWith(part.element);
		}
		this._register(instantiationService.createInstance(ChatMarkdownDecorationsRenderer, this.domNode));
	}
}
