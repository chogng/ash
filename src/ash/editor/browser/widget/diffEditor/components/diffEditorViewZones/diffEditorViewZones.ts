import { h } from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorSemanticHighlightingConfiguration } from '../../../../../common/config/editorConfigurationSchema.js';
import { EditorOption } from '../../../../../common/config/editorOptions.js';
import type { FontInfo } from '../../../../../common/config/fontInfo.js';
import { resolveSemanticTokenPresentation } from '../../../../../common/services/semanticTokensStyling.js';
import { InlineDecoration, InlineDecorationType } from '../../../../../common/viewModel/inlineDecorations.js';
import { type DiffModel } from '../../../../../common/diff/diffModel.js';
import { LineDiffKind, type LineDiffRows } from '../../../../../common/diff/lineDiff.js';
import type { LineRangeMapping } from '../../../../../common/diff/rangeMapping.js';
import { type IViewZoneChangeAccessor } from '../../../../editorBrowser.js';
import { CodeEditorWidget } from '../../../codeEditor/codeEditorWidget.js';
import { Position } from '../../../../../common/core/position.js';
import { LineSource, RenderOptions, renderLines, type RenderLinesResult } from './renderLines.js';
import { InlineDiffDeletedCodeMargin } from './inlineDiffDeletedCodeMargin.js';
import { enableCopySelection } from './copySelection.js';
import { diffDeleteDecoration } from '../../registrations.contribution.js';

interface DiffViewZone {
	readonly afterLineNumber: number;
	readonly heightInPx: number;
	readonly ordinal: number;
	readonly marginClassName?: string;
}

interface InlineOriginalLine {
	readonly element: HTMLElement;
	readonly margin: InlineDiffDeletedCodeMargin;
	readonly lineNumber: number;
	inlineDecorations?: readonly InlineDecoration[];
	rendered?: RenderLinesResult;
}

interface UnwrappedZoneLayout {
	readonly rows: LineDiffRows;
	readonly inlineView: boolean;
	readonly renderIndicators: boolean;
	readonly originalVersion: number;
	readonly modifiedVersion: number;
	readonly originalLineHeight: number;
	readonly modifiedLineHeight: number;
	readonly decorationsWidth: number;
	readonly fontInfo: FontInfo;
	readonly tabSize: number;
}

/** Owns the paired alignment zones and the original lines shown in inline mode. */
export class DiffEditorViewZones extends Disposable {
	private originalZones: string[] = [];
	private modifiedZones: string[] = [];
	private readonly inlineMargins = this._register(new DisposableStore());
	private readonly inlineMarginObserver: ResizeObserver;
	private inlineOriginalLines: { readonly version: number; readonly lines: InlineOriginalLine[]; } | undefined;
	private unwrappedZoneLayout: UnwrappedZoneLayout | undefined;

	constructor(
		private readonly originalEditor: CodeEditorWidget,
		private readonly modifiedEditor: CodeEditorWidget,
		private readonly model: DiffModel,
		@IThemeService private readonly themeService: IThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IClipboardService clipboardService: IClipboardService,
	) {
		super();
		this.inlineMarginObserver = new ResizeObserver(entries => {
			const resized = new Set(entries.map(entry => entry.target));
			this.updateInlineMargins(this.inlineOriginalLines?.lines.filter(line => resized.has(line.element)) ?? []);
		});
		this._register(toDisposable(() => this.inlineMarginObserver.disconnect()));
		this._register(enableCopySelection({
			domNode: modifiedEditor.getDomNode(),
			originalModel: model.original,
			clipboardService,
			getModelPositionAt: (element, offset) => {
				const snapshot = this.inlineOriginalLines;
				if (!snapshot || snapshot.version !== model.original.version) return undefined;
				for (const line of snapshot.lines) {
					const position = line.rendered?.getModelPositionAt(element, offset);
					if (position) return new Position(line.lineNumber + position.lineNumber - 1, position.column);
				}
				return undefined;
			},
		}));
		this._register(model.original.onDidChangeTokens(event => this.renderInlineOriginalLines(event.ranges)));
		if (model.original.tokenization.semanticTokens) {
			this._register(model.original.tokenization.semanticTokens.onDidChange(() => this.renderInlineOriginalLines()));
		}
		this._register(originalEditor.onDidChangeModelDecorations(() => {
			// Token batches do not change decorations. Refresh this derived row data
			// only when its editor owner publishes a decoration change.
			for (const line of this.inlineOriginalLines?.lines ?? []) {
				line.inlineDecorations = undefined;
			}
			this.renderInlineOriginalLines();
		}));
		this._register(themeService.onDidColorThemeChange(() => this.renderInlineOriginalLines()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(EditorSemanticHighlightingConfiguration)) {
				this.renderInlineOriginalLines();
			}
		}));
		this._register(toDisposable(() => this.clear()));
	}

	public update(inlineView: boolean, wordWrap: boolean, rows: LineDiffRows, renderIndicators: boolean, comparison?: LineRangeMapping): void {
		const previous = this.unwrappedZoneLayout;
		this.unwrappedZoneLayout = undefined;
		if (!wordWrap && !comparison) {
			const layout: UnwrappedZoneLayout = {
				rows, inlineView, renderIndicators,
				originalVersion: this.model.original.version,
				modifiedVersion: this.model.modified.version,
				originalLineHeight: this.originalEditor.getOption(EditorOption.lineHeight),
				modifiedLineHeight: this.modifiedEditor.getOption(EditorOption.lineHeight),
				decorationsWidth: this.modifiedEditor.getLayoutInfo().decorationsWidth,
				fontInfo: this.originalEditor.getOption(EditorOption.fontInfo),
				tabSize: this.model.original.getOptions().tabSize,
			};
			this.unwrappedZoneLayout = layout;
			// Without wrapping or a moved-block comparison, viewport size does not
			// change alignment. Retain zone DOM, selection and copy mappings on resize.
			if (previous && previous.rows === layout.rows && previous.inlineView === layout.inlineView
				&& previous.renderIndicators === layout.renderIndicators
				&& previous.originalVersion === layout.originalVersion && previous.modifiedVersion === layout.modifiedVersion
				&& previous.originalLineHeight === layout.originalLineHeight && previous.modifiedLineHeight === layout.modifiedLineHeight
				&& previous.decorationsWidth === layout.decorationsWidth && previous.fontInfo === layout.fontInfo && previous.tabSize === layout.tabSize) {
				return;
			}
		}
		this.inlineMarginObserver.disconnect();
		this.inlineOriginalLines = undefined;
		this.inlineMargins.clear();
		if (inlineView) {
			const layout = this.modifiedEditor.getLayoutInfo();
			const originalLineHeight = this.originalEditor.getOption(EditorOption.lineHeight);
			const lines: InlineOriginalLine[] = [];
			const original: DiffViewZone[] = [];
			const modified: DiffViewZone[] = [];
			this.inlineOriginalLines = { version: this.model.original.version, lines };
			this.modifiedEditor.changeViewZones(accessor => {
				for (const id of this.modifiedZones) accessor.removeZone(id);
				this.modifiedZones = [];
				let precedingOriginalLine = 0;
				let precedingModifiedLine = 0;
				for (const [ordinal, row] of wordWrap || this.originalEditor.getOption(EditorOption.lineHeight) !== this.modifiedEditor.getOption(EditorOption.lineHeight) ? rows.entries() : rows.alignmentEntries()) {
					const originalHeight = row.originalLineIndex === undefined ? 0 : this.lineHeightFor(this.originalEditor, row.originalLineIndex + 1, wordWrap);
					const modifiedHeight = row.modifiedLineIndex === undefined ? 0 : this.lineHeightFor(this.modifiedEditor, row.modifiedLineIndex + 1, wordWrap);
					if (row.originalLineIndex !== undefined) precedingOriginalLine = row.originalLineIndex + 1;
					if (row.kind === LineDiffKind.Unchanged) {
						this.appendViewZone(original, precedingOriginalLine, modifiedHeight - originalHeight, ordinal);
						this.appendViewZone(modified, row.modifiedLineIndex! + 1, originalHeight - modifiedHeight, ordinal);
					} else if (row.modifiedLineIndex !== undefined) {
						// Added text occupies no original-model line. Reserve its height in
						// the old number column, including the blank column's diff color.
						this.appendViewZone(original, precedingOriginalLine, modifiedHeight, ordinal, 'stanza-diff-gutter-added');
					}
					if (row.kind !== LineDiffKind.Unchanged && row.originalLineIndex !== undefined) {
						const line = h(this.modifiedEditor.getDomNode().ownerDocument, 'div');
						line.className = 'stanza-diff-inline-original-line';
						line.textContent = this.model.original.getLineContent(row.originalLineIndex + 1);
						line.setAttribute('aria-label', localize('diffEditor.removedLine', 'Removed line {0}: {1}', row.originalLineIndex + 1, line.textContent));
						// Deleted text has no modified-model line; its marker must share the zone's scroll and disposal lifecycle.
						const margin = this.inlineMargins.add(new InlineDiffDeletedCodeMargin(
							line.ownerDocument, layout.decorationsWidth, renderIndicators,
							originalLineHeight, Math.max(1, Math.round(originalHeight / originalLineHeight)),
						));
						lines.push({ element: line, margin, lineNumber: row.originalLineIndex + 1 });
						this.inlineMarginObserver.observe(line);
						this.modifiedZones.push(accessor.addZone({
							afterLineNumber: row.modifiedLineIndex ?? precedingModifiedLine,
							heightInPx: originalHeight,
							ordinal,
							domNode: line,
							marginDomNode: margin.domNode,
							isAccessible: true,
						}));
					}
					if (row.modifiedLineIndex !== undefined) precedingModifiedLine = row.modifiedLineIndex + 1;
				}
				this.modifiedZones.push(...this.addViewZones(accessor, modified));
			});
			this.originalEditor.changeViewZones(accessor => {
				for (const id of this.originalZones) accessor.removeZone(id);
				this.originalZones = this.addViewZones(accessor, original);
			});
			this.renderInlineOriginalLines();
			return;
		}

		const original: DiffViewZone[] = [];
		const modified: DiffViewZone[] = [];
		let originalAfterLineNumber = comparison ? comparison.original.startLineNumber - 1 : 0;
		let modifiedAfterLineNumber = comparison ? comparison.modified.startLineNumber - 1 : 0;
		if (comparison) {
			this.clear();
			const originalTop = this.originalEditor.getTopForLineNumber(comparison.original.startLineNumber);
			const modifiedTop = this.modifiedEditor.getTopForLineNumber(comparison.modified.startLineNumber);
			this.appendViewZone(original, originalAfterLineNumber, modifiedTop - originalTop, -1);
			this.appendViewZone(modified, modifiedAfterLineNumber, originalTop - modifiedTop, -1);
		}
		for (const [rowIndex, row] of wordWrap || comparison ? rows.entries() : rows.alignmentEntries()) {
			if (row.originalLineIndex !== undefined) originalAfterLineNumber = row.originalLineIndex + 1;
			if (row.modifiedLineIndex !== undefined) modifiedAfterLineNumber = row.modifiedLineIndex + 1;
			// Equal text can occupy different heights when the split gives each side a different wrapping width.
			if (row.kind === LineDiffKind.Unchanged && !wordWrap && !comparison) continue;
			const originalHeight = row.originalLineIndex === undefined ? 0 : this.lineHeightFor(this.originalEditor, row.originalLineIndex + 1, wordWrap);
			const modifiedHeight = row.modifiedLineIndex === undefined ? 0 : this.lineHeightFor(this.modifiedEditor, row.modifiedLineIndex + 1, wordWrap);
			const rowHeight = Math.max(originalHeight, modifiedHeight);
			this.appendViewZone(original, originalAfterLineNumber, rowHeight - originalHeight, rowIndex);
			this.appendViewZone(modified, modifiedAfterLineNumber, rowHeight - modifiedHeight, rowIndex);
		}
		if (comparison) {
			// Balance trailing space from the last model line and the zones we are about to add.
			const originalHeight = this.originalEditor.getBottomForLineNumber(this.model.original.getLineCount())
				+ this.originalEditor.getOption(EditorOption.padding).bottom
				+ original.reduce((height, zone) => height + zone.heightInPx, 0);
			const modifiedHeight = this.modifiedEditor.getBottomForLineNumber(this.model.modified.getLineCount())
				+ this.modifiedEditor.getOption(EditorOption.padding).bottom
				+ modified.reduce((height, zone) => height + zone.heightInPx, 0);
			this.appendViewZone(original, this.model.original.getLineCount(), modifiedHeight - originalHeight, rows.length);
			this.appendViewZone(modified, this.model.modified.getLineCount(), originalHeight - modifiedHeight, rows.length);
		}
		this.originalEditor.changeViewZones(accessor => {
			for (const id of this.originalZones) accessor.removeZone(id);
			this.originalZones = this.addViewZones(accessor, original);
		});
		this.modifiedEditor.changeViewZones(accessor => {
			for (const id of this.modifiedZones) accessor.removeZone(id);
			this.modifiedZones = this.addViewZones(accessor, modified);
		});
	}

	private clear(): void {
		this.unwrappedZoneLayout = undefined;
		this.inlineMarginObserver.disconnect();
		this.inlineOriginalLines = undefined;
		this.inlineMargins.clear();
		this.originalEditor.changeViewZones(accessor => {
			for (const id of this.originalZones) accessor.removeZone(id);
			this.originalZones = [];
		});
		this.modifiedEditor.changeViewZones(accessor => {
			for (const id of this.modifiedZones) accessor.removeZone(id);
			this.modifiedZones = [];
		});
	}

	private renderInlineOriginalLines(ranges?: readonly { fromLineNumber: number; toLineNumber: number; }[]): void {
		const snapshot = this.inlineOriginalLines;
		// A text edit invalidates the old row bindings until the diff rebuilds its zones.
		if (!snapshot || snapshot.version !== this.model.original.version) return;
		const theme = this.themeService.getColorTheme();
		const preference = this.configurationService.getValue<boolean | 'configuredByTheme'>(EditorSemanticHighlightingConfiguration);
		const semanticHighlighting = preference === true || (preference !== false && theme.semanticHighlighting === true);
		const options = RenderOptions.fromEditor(this.originalEditor);
		const renderedLines: InlineOriginalLine[] = [];
		for (const line of snapshot.lines) {
			const { element, lineNumber } = line;
			// Lexical batches often concern newly visible lines, while most deleted
			// rows already have current styling and source-column mappings.
			if (ranges && !ranges.some(range => range.fromLineNumber <= lineNumber && lineNumber <= range.toLineNumber)) {
				continue;
			}
			const inlineDecorations = line.inlineDecorations ??= (this.originalEditor.getLineDecorations(lineNumber) ?? []).flatMap(decoration => {
				// Deleted zones have no editor overlay. Project their diff ranges into
				// the rendered source text while retaining other inline decorations.
				const className = decoration.options.inlineClassName
					?? (decoration.options.className === diffDeleteDecoration.className ? decoration.options.className : undefined);
				return className ? [new InlineDecoration(decoration.range, className, InlineDecorationType.Regular)] : [];
			});
			line.rendered = renderLines(new LineSource([{
				lineNumber,
				content: this.model.original.getLineContent(lineNumber),
				tokens: this.model.original.tokenization.renderedTokens.getLineTokens(lineNumber - 1).map(token => ({ ...token, syntaxPresentation: resolveSemanticTokenPresentation(token, theme, semanticHighlighting) })),
			}], this.originalEditor._getViewModel()!.getVisualLineProjection()), options, inlineDecorations, element);
			renderedLines.push(line);
		}
		this.updateInlineMargins(renderedLines);
	}

	private updateInlineMargins(lines: readonly InlineOriginalLine[]): void {
		const lineHeight = this.originalEditor.getOption(EditorOption.lineHeight);
		// Count rendered rows before mutating margins, including zones that only
		// become measurable after scrolling into view.
		const updates: { margin: InlineDiffDeletedCodeMargin; count: number; }[] = [];
		for (const line of lines) {
			let firstTop = Infinity;
			let lastTop = -Infinity;
			for (const part of line.element.children) {
				for (const box of part.getClientRects()) {
					if (box.width === 0) continue;
					firstTop = Math.min(firstTop, box.top);
					lastTop = Math.max(lastTop, box.top);
				}
			}
			// Detached and hidden zones retain their initial geometry until visible.
			if (Number.isFinite(firstTop)) {
				updates.push({ margin: line.margin, count: Math.round((lastTop - firstTop) / lineHeight) + 1 });
			}
		}
		for (const update of updates) update.margin.setDisplayLineCount(update.count);
	}

	private lineHeightFor(editor: CodeEditorWidget, lineNumber: number, wordWrap: boolean): number {
		return wordWrap ? editor.getBottomForLineNumber(lineNumber) - editor.getTopForLineNumber(lineNumber) : editor.getOption(EditorOption.lineHeight);
	}

	private appendViewZone(zones: DiffViewZone[], afterLineNumber: number, heightInPx: number, ordinal: number, marginClassName?: string): void {
		if (heightInPx <= 0) return;
		const previous = zones.at(-1);
		if (previous?.afterLineNumber === afterLineNumber && previous.marginClassName === marginClassName) {
			zones[zones.length - 1] = { ...previous, heightInPx: previous.heightInPx + heightInPx };
		} else {
			zones.push({ afterLineNumber, heightInPx, ordinal, marginClassName });
		}
	}

	private addViewZones(accessor: IViewZoneChangeAccessor, zones: readonly DiffViewZone[]): string[] {
		return zones.map(zone => {
			const domNode = h(this.modifiedEditor.getDomNode().ownerDocument, 'div');
			domNode.className = 'ash-diff-alignment-zone';
			const marginDomNode = zone.marginClassName ? h(domNode.ownerDocument, 'div', { className: zone.marginClassName }) : undefined;
			return accessor.addZone({ ...zone, domNode, marginDomNode });
		});
	}
}
