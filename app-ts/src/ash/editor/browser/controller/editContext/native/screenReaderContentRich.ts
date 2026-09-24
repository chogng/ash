import { fragment as createFragment, h, text as createText } from "../../../../../base/browser/dom.js";
import { type FastDomNode } from '../../../../../base/browser/fastDomNode.js';
import { type ViewContext } from '../../../../common/viewModel/viewContext.js';
import { type EditContextViewController } from '../editContext.js';
import { projectStanzaSemanticTokenLine, type ResolvedSemanticToken, type SemanticTokenSource } from "../../../viewParts/viewLines/viewLine.js";
import { type ScreenReaderContentState } from "./screenReaderUtils.js";
import { SimpleScreenReaderContent } from "./screenReaderContentSimple.js";
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { InlineDecoration, InlineDecorationType } from '../../../../common/viewModel/inlineDecorations.js';
import { Range } from '../../../../common/core/range.js';

export interface RichScreenReaderContentOptions {
	readonly semanticTokenSource?: SemanticTokenSource;
}

/**
 * Line-structured screen-reader projection with the same token boundaries as
 * the visible Stanza text renderer.
 *
 * The text remains exact and bounded, while token and bracket spans provide a
 * stable rich DOM for assistive technology and keep DOM selection offsets in
 * the same UTF-16 coordinate space as the model.
 */
export class RichScreenReaderContent extends SimpleScreenReaderContent {
	constructor(
		domNode: FastDomNode<HTMLElement>,
		private readonly richContext: ViewContext,
		viewController: EditContextViewController,
		private readonly options: RichScreenReaderContentOptions,
	) {
		super(domNode, richContext, viewController);
		const model = richContext.viewModel.model;
		if (options.semanticTokenSource && options.semanticTokenSource.textModel !== model) {
			throw new TypeError("Native rich screen-reader semantic tokens must share the text model");
		}
	}

	protected override renderText(text: string, state: ScreenReaderContentState): void {
		const ownerDocument = this.element.ownerDocument;
		const fragment = createFragment(ownerDocument);
		for (const [index, segment] of state.segments.entries()) {
			if (index > 0) {
				fragment.append(createText(ownerDocument, text.slice(
					state.segments[index - 1]!.contentEndOffset,
					segment.contentStartOffset,
				)));
			}
			const segmentText = text.slice(segment.contentStartOffset, segment.contentEndOffset);
			const startPosition = this.richContext.viewModel.model.getPositionAt(segment.modelStartOffset);
			renderSegment(
				fragment,
				segmentText,
				startPosition.lineNumber - 1,
				startPosition.column - 1,
				this.options,
				this.richContext,
			);
		}
		this.element.replaceChildren(fragment);
	}
}

function renderSegment(
	fragment: DocumentFragment,
	text: string,
	startLineIndex: number,
	startColumn: number,
	options: RichScreenReaderContentOptions,
	context: ViewContext,
): void {
	const ownerDocument = fragment.ownerDocument;
	const lines = text.split("\n");
	const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
	let lineIndex = startLineIndex;
	let lineStartColumn = startColumn;
	for (let index = 0; index < lineCount; index += 1) {
		const lineText = lines[index]!;
		const lineElement = h(ownerDocument, "span");
		lineElement.dataset.lineIndex = String(lineIndex);
		const lineEndColumn = lineStartColumn + lineText.length;
		const decorations = context.configuration.options.get(EditorOption.bracketPairColorization).enabled
			? context.viewModel.model.getLineDecorations(lineIndex + 1).filter(decoration => decoration.options.description === 'BracketPairColorization')
			: [];
		const inlineDecorations = decorations.flatMap(decoration => {
			const start = Math.max(lineStartColumn, decoration.range.startColumn - 1);
			const end = Math.min(lineEndColumn, decoration.range.endColumn - 1);
			if (start >= end) {
				return [];
			}
			const range = new Range(1, start - lineStartColumn + 1, 1, end - lineStartColumn + 1);
			return [new InlineDecoration(range, decoration.options.inlineClassName!, InlineDecorationType.Regular)];
		});
		projectStanzaSemanticTokenLine(
			lineElement,
			lineText,
			clipSemanticTokens(options.semanticTokenSource?.getLineTokens(lineIndex) ?? [], lineStartColumn, lineEndColumn),
			context.viewModel.model.getOptions().tabSize,
			inlineDecorations,
		);
		if (!lineElement.firstChild) lineElement.append(createText(ownerDocument, ""));
		fragment.append(lineElement);
		if (index < lines.length - 1) fragment.append(createText(ownerDocument, "\n"));
		lineIndex += 1;
		lineStartColumn = 0;
	}
}

function clipSemanticTokens(
	tokens: readonly ResolvedSemanticToken[],
	startColumn: number,
	endColumn: number,
): readonly ResolvedSemanticToken[] {
	return Object.freeze(tokens.flatMap(token => {
		const start = Math.max(token.startColumn, startColumn);
		const end = Math.min(token.endColumn, endColumn);
		if (end <= start) return [];
		return [Object.freeze({
			startColumn: start - startColumn,
			endColumn: end - startColumn,
			...(token.presentation === undefined ? {} : { presentation: token.presentation }),
			...(token.modifiers === undefined ? {} : { modifiers: token.modifiers }),
			...(token.syntaxPresentation === undefined ? {} : { syntaxPresentation: token.syntaxPresentation }),
		})];
	}));
}
