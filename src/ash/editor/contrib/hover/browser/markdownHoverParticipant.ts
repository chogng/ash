import { h } from '../../../../base/browser/dom.js';
import type { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Range } from '../../../common/core/range.js';
import type { HoverAnchor, IEditorHoverParticipant, IEditorHoverRenderContext, IHoverPart, IRenderedHoverParts } from './hoverTypes.js';

class MarkdownHover implements IHoverPart {
	constructor(
		readonly owner: MarkdownHoverParticipant,
		readonly range: Range,
		readonly contents: readonly IMarkdownString[],
		readonly decorationId: string,
	) {}
}

/** Displays model decoration documentation without requesting a language provider or reading its source. */
export class MarkdownHoverParticipant implements IEditorHoverParticipant {
	constructor(
		private readonly editor: ICodeEditor,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
	) {}

	computeSync(anchor: HoverAnchor): MarkdownHover[] {
		const model = this.editor.getModel();
		if (!model) return [];
		const result: MarkdownHover[] = [];
		for (const decoration of this.editor.getLineDecorations(anchor.position.lineNumber) ?? []) {
			const message = decoration.options.hoverMessage;
			if (!message || !Range.containsPosition(decoration.range, anchor.position)) continue;
			const contents = (Array.isArray(message) ? message : [message]).filter(content => content.value.trim().length > 0);
			if (contents.length > 0) result.push(new MarkdownHover(this, Range.lift(decoration.range), contents, decoration.id));
		}
		return result;
	}

	renderHoverParts(context: IEditorHoverRenderContext, parts: IHoverPart[]): IRenderedHoverParts {
		const resources = new DisposableStore();
		const renderedMessages = resources.add(new DisposableStore());
		const content = h(context.container.ownerDocument, 'div');
		content.className = 'stanza-editor-hover-content markdown-hover';
		content.tabIndex = -1;
		const ownedParts = parts.filter((part): part is MarkdownHover => part instanceof MarkdownHover && part.owner === this);
		let messages = ownedParts.flatMap(part => part.contents);
		const render = () => {
			renderedMessages.clear();
			content.replaceChildren();
			for (const message of messages) {
				const rendered = renderedMessages.add(
					this.markdownRenderer.render(message, {
						ownerDocument: content.ownerDocument,
						asyncRenderCallback: () => {
							if (!resources.isDisposed) context.onContentsChanged();
						},
					}),
				);
				content.append(rendered.element);
			}
		};
		render();
		context.container.append(content);
		resources.add(
			this.editor.onDidChangeModelDecorations(() => {
				const model = this.editor.getModel();
				if (ownedParts.some(part => !model?.getDecorationRange(part.decorationId))) {
					context.hide();
					return;
				}
				const next = ownedParts.flatMap(part => {
					const message = model!.getDecorationOptions(part.decorationId)?.hoverMessage;
					if (!message) return [];
					return Array.isArray(message) ? message : [message];
				});
				if (next.length === messages.length && next.every((message, index) => message === messages[index])) return;
				messages = next;
				render();
				context.onContentsChanged();
			}),
		);
		resources.add(toDisposable(() => content.remove()));
		return Object.assign(resources, {
			focus: () => content.focus({ preventScroll: true }),
			isUpdatingEditor: () => false,
		});
	}
}
