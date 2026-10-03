import { h } from '../../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorSemanticHighlightingConfiguration } from '../../../../../common/config/editorConfigurationSchema.js';
import { EditorOption } from '../../../../../common/config/editorOptions.js';
import { resolveSemanticTokenPresentation } from '../../../../../common/services/semanticTokensStyling.js';
import { InlineDecoration, InlineDecorationType } from '../../../../../common/viewModel/inlineDecorations.js';
import { type DiffModel } from '../../../../../common/diff/diffModel.js';
import { LineDiffKind, type LineDiffRow } from '../../../../../common/diff/lineDiff.js';
import type { LineRangeMapping } from '../../../../../common/diff/rangeMapping.js';
import { type IViewZoneChangeAccessor } from '../../../../editorBrowser.js';
import { projectStanzaSemanticTokenLine } from '../../../../viewParts/viewLines/viewLine.js';
import { CodeEditorWidget } from '../../../codeEditor/codeEditorWidget.js';

interface DiffViewZone {
	readonly afterLineNumber: number;
	readonly heightInPx: number;
	readonly ordinal: number;
}

/** Owns the paired alignment zones and the original lines shown in inline mode. */
export class DiffEditorViewZones extends Disposable {
	private originalZones: string[] = [];
	private modifiedZones: string[] = [];
	private inlineOriginalLines: { readonly version: number; readonly lines: { readonly element: HTMLElement; readonly lineNumber: number }[] } | undefined;

	constructor(
		private readonly originalEditor: CodeEditorWidget,
		private readonly modifiedEditor: CodeEditorWidget,
		private readonly model: DiffModel,
		private readonly lineHeight: number,
		@IThemeService private readonly themeService: IThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(model.original.tokenization.renderedTokens.onDidChange(() => this.renderInlineOriginalLines()));
		this._register(originalEditor.onDidChangeModelDecorations(() => this.renderInlineOriginalLines()));
		this._register(themeService.onDidColorThemeChange(() => this.renderInlineOriginalLines()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(EditorSemanticHighlightingConfiguration)) {
				this.renderInlineOriginalLines();
			}
		}));
		this._register(toDisposable(() => this.clear()));
	}

	public update(inlineView: boolean, wordWrap: boolean, rows: readonly LineDiffRow[], comparison?: LineRangeMapping): void {
		this.inlineOriginalLines = undefined;
		if (inlineView) {
			const lines: { readonly element: HTMLElement; readonly lineNumber: number }[] = [];
			this.inlineOriginalLines = { version: this.model.original.version, lines };
			this.originalEditor.changeViewZones(accessor => {
				for (const id of this.originalZones) accessor.removeZone(id);
				this.originalZones = [];
			});
			this.modifiedEditor.changeViewZones(accessor => {
				for (const id of this.modifiedZones) accessor.removeZone(id);
				this.modifiedZones = [];
				let precedingModifiedLine = 0;
				for (const [ordinal, row] of rows.entries()) {
					if (row.kind !== LineDiffKind.Unchanged && row.originalLineIndex !== undefined) {
						const line = h(this.modifiedEditor.getDomNode().ownerDocument, 'div');
						line.className = 'stanza-diff-inline-original-line';
						line.textContent = this.model.original.getLineContent(row.originalLineIndex + 1);
						line.setAttribute('aria-label', localize('diffEditor.removedLine', 'Removed line {0}: {1}', row.originalLineIndex + 1, line.textContent));
						lines.push({ element: line, lineNumber: row.originalLineIndex + 1 });
						this.modifiedZones.push(accessor.addZone({
							afterLineNumber: row.modifiedLineIndex ?? precedingModifiedLine,
							heightInPx: this.lineHeight,
							ordinal,
							domNode: line,
							isAccessible: true,
						}));
					}
					if (row.modifiedLineIndex !== undefined) precedingModifiedLine = row.modifiedLineIndex + 1;
				}
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
		for (const [rowIndex, row] of rows.entries()) {
			if (row.originalLineIndex !== undefined) originalAfterLineNumber = row.originalLineIndex + 1;
			if (row.modifiedLineIndex !== undefined) modifiedAfterLineNumber = row.modifiedLineIndex + 1;
			if (row.kind === LineDiffKind.Unchanged && !comparison) continue;
			const originalHeight = row.originalLineIndex === undefined ? 0 : this.lineHeightFor(this.originalEditor, row.originalLineIndex + 1, wordWrap);
			const modifiedHeight = row.modifiedLineIndex === undefined ? 0 : this.lineHeightFor(this.modifiedEditor, row.modifiedLineIndex + 1, wordWrap);
			const rowHeight = Math.max(originalHeight, modifiedHeight);
			this.appendViewZone(original, originalAfterLineNumber, rowHeight - originalHeight, rowIndex);
			this.appendViewZone(modified, modifiedAfterLineNumber, rowHeight - modifiedHeight, rowIndex);
		}
		if (comparison) {
			// Content height is floored at the viewport height. Compare text extents instead,
			// so a tall viewport does not turn unused space into unequal trailing zones.
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
		this.inlineOriginalLines = undefined;
		this.originalEditor.changeViewZones(accessor => {
			for (const id of this.originalZones) accessor.removeZone(id);
			this.originalZones = [];
		});
		this.modifiedEditor.changeViewZones(accessor => {
			for (const id of this.modifiedZones) accessor.removeZone(id);
			this.modifiedZones = [];
		});
	}

	private renderInlineOriginalLines(): void {
		const snapshot = this.inlineOriginalLines;
		// A text edit invalidates the old row bindings until the diff rebuilds its zones.
		if (!snapshot || snapshot.version !== this.model.original.version) return;
		const theme = this.themeService.getColorTheme();
		const preference = this.configurationService.getValue<boolean | 'configuredByTheme'>(EditorSemanticHighlightingConfiguration);
		const semanticHighlighting = preference === true || (preference !== false && theme.semanticHighlighting === true);
		for (const { element, lineNumber } of snapshot.lines) {
			const inlineDecorations = (this.originalEditor.getLineDecorations(lineNumber) ?? []).flatMap(decoration => decoration.options.inlineClassName
				? [new InlineDecoration(decoration.range, decoration.options.inlineClassName, InlineDecorationType.Regular)]
				: []);
			projectStanzaSemanticTokenLine(
				element,
				this.model.original.getLineContent(lineNumber),
				this.model.original.tokenization.renderedTokens.getLineTokens(lineNumber - 1).map(token => ({ ...token, syntaxPresentation: resolveSemanticTokenPresentation(token, theme, semanticHighlighting) })),
				this.model.original.getOptions().tabSize,
				inlineDecorations,
				lineNumber,
			);
		}
	}

	private lineHeightFor(editor: CodeEditorWidget, lineNumber: number, wordWrap: boolean): number {
		return wordWrap ? editor.getBottomForLineNumber(lineNumber) - editor.getTopForLineNumber(lineNumber) : this.lineHeight;
	}

	private appendViewZone(zones: DiffViewZone[], afterLineNumber: number, heightInPx: number, ordinal: number): void {
		if (heightInPx <= 0) return;
		const previous = zones.at(-1);
		if (previous?.afterLineNumber === afterLineNumber) {
			zones[zones.length - 1] = { ...previous, heightInPx: previous.heightInPx + heightInPx };
		} else {
			zones.push({ afterLineNumber, heightInPx, ordinal });
		}
	}

	private addViewZones(accessor: IViewZoneChangeAccessor, zones: readonly DiffViewZone[]): string[] {
		return zones.map(zone => accessor.addZone({ ...zone, domNode: h(this.modifiedEditor.getDomNode().ownerDocument, 'div') }));
	}
}
