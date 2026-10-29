import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Range } from '../../../../common/core/range.js';
import { type LineDiffRows, type LineDiffRow } from '../../../../common/diff/lineDiff.js';
import { type IEditorDecorationsCollection } from '../../../../common/editorCommon.js';
import { type IModelDeltaDecoration, type IModelDecorationOptions } from '../../../../common/model.js';
import { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';
import {
	diffAddDecoration,
	diffAddDecorationEmpty,
	diffDeleteDecoration,
	diffDeleteDecorationEmpty,
	diffLineAddDecorationBackground,
	diffLineAddDecorationBackgroundWithIndicator,
	diffLineDeleteDecorationBackground,
	diffLineDeleteDecorationBackgroundWithIndicator,
} from '../registrations.contribution.js';

export class DiffEditorDecorations extends Disposable {
	private readonly original: IEditorDecorationsCollection;
	private readonly modified: IEditorDecorationsCollection;

	constructor(originalEditor: CodeEditorWidget, modifiedEditor: CodeEditorWidget) {
		super();
		this.original = originalEditor.createDecorationsCollection();
		this.modified = modifiedEditor.createDecorationsCollection();
		this._register(
			toDisposable(() => {
				this.original.clear();
				this.modified.clear();
			}),
		);
	}

	public update(rows: LineDiffRows, showInlineChanges: boolean, renderIndicators: boolean): void {
		const original: IModelDeltaDecoration[] = [];
		const modified: IModelDeltaDecoration[] = [];
		for (const [, row] of rows.changedEntries()) {
			if (row.originalLineIndex !== undefined) {
				original.push({
					range: new Range(row.originalLineIndex + 1, 1, row.originalLineIndex + 1, 1),
					options: renderIndicators ? diffLineDeleteDecorationBackgroundWithIndicator : diffLineDeleteDecorationBackground,
				});
				if (showInlineChanges) {
					addInlineDecorations(original, row.originalLineIndex + 1, row.originalChanges, diffDeleteDecoration, diffDeleteDecorationEmpty);
				}
			}
			if (row.modifiedLineIndex !== undefined) {
				modified.push({
					range: new Range(row.modifiedLineIndex + 1, 1, row.modifiedLineIndex + 1, 1),
					options: renderIndicators ? diffLineAddDecorationBackgroundWithIndicator : diffLineAddDecorationBackground,
				});
				if (showInlineChanges) {
					addInlineDecorations(modified, row.modifiedLineIndex + 1, row.modifiedChanges, diffAddDecoration, diffAddDecorationEmpty);
				}
			}
		}
		this.original.set(original);
		this.modified.set(modified);
	}
}

function addInlineDecorations(
	target: IModelDeltaDecoration[],
	lineNumber: number,
	changes: LineDiffRow['originalChanges'],
	options: IModelDecorationOptions,
	emptyOptions: IModelDecorationOptions,
): void {
	for (const change of changes) {
		target.push({
			range: new Range(lineNumber, change.startColumn + 1, lineNumber, change.endColumn + 1),
			options: change.startColumn === change.endColumn ? emptyOptions : options,
		});
	}
}
