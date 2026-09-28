import { h } from '../../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { type DiffModel } from '../../../../../common/diff/diffModel.js';
import { LineDiffKind } from '../../../../../common/diff/lineDiff.js';
import { type IViewZoneChangeAccessor } from '../../../../editorBrowser.js';
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

	constructor(
		private readonly originalEditor: CodeEditorWidget,
		private readonly modifiedEditor: CodeEditorWidget,
		private readonly model: DiffModel,
		private readonly lineHeight: number,
	) {
		super();
		this._register(toDisposable(() => this.clear()));
	}

	public update(inlineView: boolean, wordWrap: boolean): void {
		const rows = this.model.diff?.rows ?? [];
		if (inlineView) {
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
			return;
		}

		const original: DiffViewZone[] = [];
		const modified: DiffViewZone[] = [];
		let originalAfterLineNumber = 0;
		let modifiedAfterLineNumber = 0;
		for (const [rowIndex, row] of rows.entries()) {
			if (row.originalLineIndex !== undefined) originalAfterLineNumber = row.originalLineIndex + 1;
			if (row.modifiedLineIndex !== undefined) modifiedAfterLineNumber = row.modifiedLineIndex + 1;
			if (row.kind === LineDiffKind.Unchanged) continue;
			const originalHeight = row.originalLineIndex === undefined ? 0 : this.lineHeightFor(this.originalEditor, row.originalLineIndex + 1, wordWrap);
			const modifiedHeight = row.modifiedLineIndex === undefined ? 0 : this.lineHeightFor(this.modifiedEditor, row.modifiedLineIndex + 1, wordWrap);
			const rowHeight = Math.max(originalHeight, modifiedHeight);
			this.appendViewZone(original, originalAfterLineNumber, rowHeight - originalHeight, rowIndex);
			this.appendViewZone(modified, modifiedAfterLineNumber, rowHeight - modifiedHeight, rowIndex);
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
		this.originalEditor.changeViewZones(accessor => {
			for (const id of this.originalZones) accessor.removeZone(id);
			this.originalZones = [];
		});
		this.modifiedEditor.changeViewZones(accessor => {
			for (const id of this.modifiedZones) accessor.removeZone(id);
			this.modifiedZones = [];
		});
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
