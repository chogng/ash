import { h } from '../../../../../../base/browser/dom.js';
import { Position } from '../../../../../common/core/position.js';
import { EditorOption } from '../../../../../common/config/editorOptions.js';
import type { FontInfo } from '../../../../../common/config/fontInfo.js';
import type { ResolvedSemanticToken } from '../../../../../common/tokens/languageTokens.js';
import { DomPosition, type CharacterMapping } from '../../../../../common/viewLayout/viewLineRenderer.js';
import type { InlineDecoration } from '../../../../../common/viewModel/inlineDecorations.js';
import type { ICodeEditor } from '../../../../editorBrowser.js';
import { applyFontInfo } from '../../../../config/domFontInfo.js';
import { projectStanzaSemanticTokenLine } from '../../../../viewParts/viewLines/viewLine.js';

/** Resolved original-model lines; token styling remains owned by the caller's theme pipeline. */
export class LineSource {
	constructor(public readonly lines: readonly { lineNumber: number; content: string; tokens: readonly ResolvedSemanticToken[]; }[]) { }
}

export class RenderOptions {
	public static fromEditor(editor: ICodeEditor): RenderOptions {
		return new RenderOptions(editor.getOption(EditorOption.fontInfo), editor.getModel()!.getOptions().tabSize);
	}

	private constructor(public readonly fontInfo: FontInfo, public readonly tabSize: number) { }
}

/** Retains source-column mappings for copying text from the rendered deletion. */
export class RenderLinesResult {
	constructor(private readonly lines: readonly { domNode: HTMLElement; mapping: CharacterMapping; }[]) { }

	public getModelPositionAt(domNode: HTMLElement, offset: number): Position | undefined {
		if (!Number.isSafeInteger(offset) || offset < 0) {
			return undefined;
		}
		for (const [index, line] of this.lines.entries()) {
			if (domNode === line.domNode) {
				if (offset > domNode.childNodes.length) {
					return undefined;
				}
				const last = offset === domNode.childNodes.length;
				const part = last ? domNode.lastElementChild : domNode.children[offset];
				if (!part) {
					return new Position(index + 1, 1);
				}
				return this.getModelPositionAt(part as HTMLElement, last ? part.textContent?.length ?? 0 : 0);
			}
			const partIndex = Array.prototype.indexOf.call(line.domNode.children, domNode) as number;
			const length = domNode.textContent?.length ?? 0;
			if (partIndex >= 0 && offset >= 0 && offset <= length) {
				return new Position(index + 1, line.mapping.getColumn(new DomPosition(partIndex, offset), length));
			}
		}
		return undefined;
	}
}

export function renderLines(source: LineSource, options: RenderOptions, decorations: readonly InlineDecoration[], domNode: HTMLElement): RenderLinesResult {
	const nodes = source.lines.length === 1 ? [domNode] : source.lines.map(() => h(domNode.ownerDocument, 'div'));
	if (source.lines.length !== 1) {
		domNode.replaceChildren(...nodes);
	}
	const lines = source.lines.map((line, index) => {
		const node = nodes[index]!;
		applyFontInfo(node, options.fontInfo);
		return { domNode: node, mapping: projectStanzaSemanticTokenLine(node, line.content, line.tokens, options.tabSize, decorations, line.lineNumber) };
	});
	return new RenderLinesResult(lines);
}
