import { h } from '../../../../../../base/browser/dom.js';
import { Position } from '../../../../../common/core/position.js';
import { Range } from '../../../../../common/core/range.js';
import { EditorOption } from '../../../../../common/config/editorOptions.js';
import type { FontInfo } from '../../../../../common/config/fontInfo.js';
import type { ResolvedSemanticToken } from '../../../../../common/tokens/languageTokens.js';
import { DomPosition, type CharacterMapping } from '../../../../../common/viewLayout/viewLineRenderer.js';
import { InlineDecoration } from '../../../../../common/viewModel/inlineDecorations.js';
import type { EditorVisualLineProjection } from '../../../../../common/viewModel/modelLineProjection.js';
import type { ICodeEditor } from '../../../../editorBrowser.js';
import { applyFontInfo } from '../../../../config/domFontInfo.js';
import { projectStanzaSemanticTokenLine } from '../../../../viewParts/viewLines/viewLine.js';

/** Resolved original-model lines; token styling remains owned by the caller's theme pipeline. */
export class LineSource {
	constructor(
		public readonly lines: readonly {
			lineNumber: number;
			content: string;
			tokens: readonly ResolvedSemanticToken[];
		}[],
		public readonly projection?: EditorVisualLineProjection,
	) {}
}

export class RenderOptions {
	public static fromEditor(editor: ICodeEditor): RenderOptions {
		return new RenderOptions(editor.getOption(EditorOption.fontInfo), editor.getModel()!.getOptions().tabSize);
	}

	private constructor(
		public readonly fontInfo: FontInfo,
		public readonly tabSize: number,
	) {}
}

/** Retains source-column mappings for copying text from the rendered deletion. */
export class RenderLinesResult {
	constructor(
		private readonly lines: readonly {
			domNode: HTMLElement;
			mapping: CharacterMapping;
			lineNumber: number;
			startColumn: number;
		}[],
	) {}

	public getModelPositionAt(domNode: HTMLElement, offset: number): Position | undefined {
		if (!Number.isSafeInteger(offset) || offset < 0) {
			return undefined;
		}
		if (this.lines.length > 1 && domNode === this.lines[0]!.domNode.parentElement) {
			const last = offset === domNode.childNodes.length;
			const part = last ? domNode.lastElementChild : domNode.children[offset];
			return part ? this.getModelPositionAt(part as HTMLElement, last ? part.childNodes.length : 0) : undefined;
		}
		for (const line of this.lines) {
			if (domNode === line.domNode) {
				if (offset > domNode.childNodes.length) {
					return undefined;
				}
				const last = offset === domNode.childNodes.length;
				const part = last ? domNode.lastElementChild : domNode.children[offset];
				if (!part) {
					return new Position(line.lineNumber, line.startColumn + 1);
				}
				return this.getModelPositionAt(part as HTMLElement, last ? (part.textContent?.length ?? 0) : 0);
			}
			const partIndex = Array.prototype.indexOf.call(line.domNode.children, domNode) as number;
			const length = domNode.textContent?.length ?? 0;
			if (partIndex >= 0 && offset >= 0 && offset <= length) {
				return new Position(
					line.lineNumber,
					line.startColumn + line.mapping.getColumn(new DomPosition(partIndex, offset), length),
				);
			}
		}
		return undefined;
	}
}

export function renderLines(
	source: LineSource,
	options: RenderOptions,
	decorations: readonly InlineDecoration[],
	domNode: HTMLElement,
): RenderLinesResult {
	// Use the original editor's breaks so token backgrounds can occupy a full
	// display row without changing wrapping or source columns used by Copy.
	const rows = source.lines.flatMap((line, index) => {
		const segments: { startColumn: number; endColumn: number; indent: number }[] = [];
		const projection = source.projection;
		if (projection) {
			for (
				let row = projection.firstVisualLineIndex(line.lineNumber - 1);
				row < projection.visualLineCount;
				row++
			) {
				const visualLine = projection.lineAt(row)!;
				if (visualLine.logicalLineIndex !== line.lineNumber - 1) break;
				segments.push({
					startColumn: visualLine.startColumn,
					endColumn: visualLine.endColumn,
					indent: visualLine.wrappedTextIndentWidth ?? 0,
				});
			}
		} else {
			segments.push({ startColumn: 0, endColumn: line.content.length, indent: 0 });
		}
		return segments.map(segment => ({ line, lineNumber: index + 1, ...segment }));
	});
	const nodes =
		rows.length === 1
			? [domNode]
			: rows.map((_, index) => {
					const existing = domNode.children[index];
					return existing?.classList.contains('ash-diff-original-row')
						? (existing as HTMLElement)
						: h(domNode.ownerDocument, 'div', { className: 'ash-diff-original-row' });
				});
	if (
		rows.length !== 1 &&
		(nodes.length !== domNode.children.length || nodes.some((node, index) => node !== domNode.children[index]))
	) {
		domNode.replaceChildren(...nodes);
	}
	applyFontInfo(domNode, options.fontInfo);
	const lines = rows.map(({ line, lineNumber, startColumn, endColumn, indent }, index) => {
		const node = nodes[index]!;
		node.style.paddingInlineStart = `${indent}px`;
		const tokens = line.tokens.flatMap(token => {
			const start = Math.max(startColumn, token.startColumn);
			const end = Math.min(endColumn, token.endColumn);
			return end > start ? [{ ...token, startColumn: start - startColumn, endColumn: end - startColumn }] : [];
		});
		const rowDecorations = decorations.flatMap(decoration => {
			if (decoration.range.startLineNumber > line.lineNumber || decoration.range.endLineNumber < line.lineNumber)
				return [];
			const start = Math.max(
				startColumn,
				decoration.range.startLineNumber === line.lineNumber ? decoration.range.startColumn - 1 : 0,
			);
			const end = Math.min(
				endColumn,
				decoration.range.endLineNumber === line.lineNumber
					? decoration.range.endColumn - 1
					: line.content.length,
			);
			return end >= start
				? [
						new InlineDecoration(
							new Range(1, start - startColumn + 1, 1, end - startColumn + 1),
							decoration.inlineClassName,
							decoration.type,
						),
					]
				: [];
		});
		return {
			domNode: node,
			lineNumber,
			startColumn,
			mapping: projectStanzaSemanticTokenLine(
				node,
				line.content.slice(startColumn, endColumn),
				tokens,
				options.tabSize,
				rowDecorations,
			),
		};
	});
	return new RenderLinesResult(lines);
}
