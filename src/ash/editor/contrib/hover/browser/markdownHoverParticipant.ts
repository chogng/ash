import { h } from '../../../../base/browser/dom.js';
import { isMarkdownString, type IMarkdownString } from '../../../../base/common/htmlContent.js';
import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Range } from '../../../common/core/range.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent } from '../../../common/languages.js';
import { TextModel } from '../../../common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import type { HoverAnchor, IEditorHoverParticipant, IEditorHoverRenderContext, IHoverPart, IRenderedHoverParts } from './hoverTypes.js';

class MarkdownHover implements IHoverPart {
	constructor(
		readonly owner: MarkdownHoverParticipant,
		readonly range: Range,
		readonly contents: readonly IMarkdownString[],
		readonly decorationId?: string,
	) { }
}

/** Supplies Markdown from both editor decorations and language providers. */
export class MarkdownHoverParticipant implements IEditorHoverParticipant {
	get onDidChange() { return this.languageFeatures.hoverProvider.onDidChange; }

	constructor(
		private readonly editor: ICodeEditor,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
	) { }

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

	async *computeAsync(anchor: HoverAnchor, signal: AbortSignal, onError: (error: unknown) => void): AsyncIterable<MarkdownHover> {
		const model = this.editor.getModel();
		if (!(model instanceof TextModel)) return;
		const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri, position: anchor.position };
		for (const provider of this.languageFeatures.hoverProvider.ordered(model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return;
			try {
				const hover = await provider.provideHover(request, signal);
				if (!isLanguageFeatureRequestCurrent(request)) return;
				if (!hover) continue;
				if (!isNonEmptyArray(hover.contents) || !hover.contents.every(isMarkdownString)) {
					throw new TypeError('Language hover must contain Markdown strings');
				}
				const contents = hover.contents.filter(content => content.value.trim().length > 0);
				if (!contents.length) continue;
				yield new MarkdownHover(this, hover.range ? Range.lift(hover.range) : Range.fromPositions(anchor.position), contents);
				return;
			} catch (error) {
				if (!signal.aborted) onError(error);
			}
		}
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
				const rendered = renderedMessages.add(this.markdownRenderer.render(message, {
					ownerDocument: content.ownerDocument,
					asyncRenderCallback: () => { if (!resources.isDisposed) context.onContentsChanged(); },
				}));
				content.append(rendered.element);
			}
		};
		render();
		context.container.append(content);
		if (ownedParts.some(part => part.decorationId !== undefined)) {
			resources.add(this.editor.onDidChangeModelDecorations(() => {
				const model = this.editor.getModel();
				if (ownedParts.some(part => part.decorationId !== undefined && !model?.getDecorationRange(part.decorationId))) { context.hide(); return; }
				const next = ownedParts.flatMap(part => {
					if (part.decorationId === undefined) return part.contents;
					const message = model!.getDecorationOptions(part.decorationId)?.hoverMessage;
					return message ? (Array.isArray(message) ? message : [message]) : [];
				});
				if (next.length === messages.length && next.every((message, index) => message === messages[index])) return;
				messages = next;
				render();
				context.onContentsChanged();
			}));
		}
		resources.add(toDisposable(() => content.remove()));
		return Object.assign(resources, {
			focus: () => content.focus({ preventScroll: true }),
			isUpdatingEditor: () => false,
		});
	}
}
