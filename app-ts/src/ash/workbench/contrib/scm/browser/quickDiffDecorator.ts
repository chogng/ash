import { Disposable } from '../../../../base/common/lifecycle.js';
import { themeColorFromId } from '../../../../base/common/themables.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { LineDiffKind, type LineDiffRow } from '../../../../editor/common/diff/lineDiff.js';
import { TextDecorationCollection } from '../../../../editor/common/model/decorationCollection.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';

import { type IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ColorId } from '../../../../platform/theme/common/colorTheme.js';
import { type QuickDiffComparison, type QuickDiffModelReference } from '../common/quickDiff.js';
import { ScmConfiguration } from '../common/scmConfiguration.js';
import { MinimapPosition, OverviewRulerLane, TrackedRangeStickiness, type IModelDecorationOptions } from '../../../../editor/common/model.js';

interface QuickDiffDecorationMetadata {
	readonly kind: LineDiffKind.Added | LineDiffKind.Modified | LineDiffKind.Removed;
	readonly providerLabels: readonly string[];
}

/** Projects one shared Quick Diff model into gutter, overview-ruler, and minimap decorations. */
export class QuickDiffDecorator extends Disposable {
	private readonly collection: TextDecorationCollection<QuickDiffDecorationMetadata>;

	constructor(private readonly model: TextModel, modelReference: QuickDiffModelReference, private readonly configurationService: IConfigurationService) {
		super();
		this.collection = this._register(new TextDecorationCollection<QuickDiffDecorationMetadata>(model));
		this._register(modelReference.object.onDidChange(() => this.rebuild(modelReference.object.state.comparisons)));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ScmConfiguration.diffDecorations)) this.rebuild(modelReference.object.state.comparisons);
		}));
		this.rebuild(modelReference.object.state.comparisons);
	}

	private resolve(metadata: QuickDiffDecorationMetadata): Omit<IModelDecorationOptions, 'stickiness'> {
		const setting = this.configurationService.getValue(ScmConfiguration.diffDecorations);
		const gutter = setting === 'all' || setting === 'gutter';
		const color = themeColorFromId(colorForKind(metadata.kind));
		return {
			description: 'dirty-diff-decoration',
			isWholeLine: metadata.kind !== LineDiffKind.Removed,
			...(gutter ? {
				linesDecorationsClassName: `ash-quick-diff-gutter ${classNameForKind(metadata.kind)}`,
				linesDecorationsTooltip: hoverText(metadata),
			} : {}),
			...((setting === 'all' || setting === 'overview') ? {
				overviewRuler: { color, position: OverviewRulerLane.Left },
			} : {}),
			...((setting === 'all' || setting === 'minimap') ? {
				minimap: { color, position: MinimapPosition.Gutter },
			} : {}),
		};
	}

	private rebuild(comparisons: readonly QuickDiffComparison[]): void {
		const setting = this.configurationService.getValue(ScmConfiguration.diffDecorations);
		if (setting === 'none') {
			this.collection.clear();
			return;
		}
		const byLine = new Map<number, QuickDiffDecorationMetadata>();
		for (const comparison of comparisons) {
			const rows = comparison.model.diff?.rows ?? [];
			for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
				const row = rows[rowIndex]!;
				if (row.kind === LineDiffKind.Unchanged) continue;
				const lineIndex = row.modifiedLineIndex ?? deletionAnchor(rows, rowIndex, this.model.lineCount);
				const kind = decorationKindForRow(row);
				const current = byLine.get(lineIndex);
				if (!current || kindPriority(kind) > kindPriority(current.kind)) {
					byLine.set(lineIndex, Object.freeze({ kind, providerLabels: Object.freeze([comparison.original.label]) }));
				} else if (!current.providerLabels.includes(comparison.original.label)) {
					byLine.set(lineIndex, Object.freeze({ ...current, providerLabels: Object.freeze([...current.providerLabels, comparison.original.label]) }));
				}
			}
		}
		this.collection.replaceAll(Object.freeze([...byLine.entries()].sort(([left], [right]) => left - right).map(([lineIndex, metadata]) => Object.freeze({
				range: Range.fromPositions(new Position((lineIndex) + 1, (0) + 1), new Position((lineIndex) + 1, (this.model.getLineLength((lineIndex) + 1)) + 1)),
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				options: this.resolve(metadata),
				metadata,
		}))));
	}
}

function deletionAnchor(rows: readonly LineDiffRow[], rowIndex: number, lineCount: number): number {
	for (let index = rowIndex + 1; index < rows.length; index += 1) {
		const lineIndex = rows[index]?.modifiedLineIndex;
		if (lineIndex !== undefined) return lineIndex;
	}
	for (let index = rowIndex - 1; index >= 0; index -= 1) {
		const lineIndex = rows[index]?.modifiedLineIndex;
		if (lineIndex !== undefined) return lineIndex;
	}
	return Math.max(0, lineCount - 1);
}

function decorationKindForRow(row: LineDiffRow): QuickDiffDecorationMetadata['kind'] {
	switch (row.kind) {
		case LineDiffKind.Added: return LineDiffKind.Added;
		case LineDiffKind.Modified: return LineDiffKind.Modified;
		case LineDiffKind.Removed: return LineDiffKind.Removed;
		case LineDiffKind.Unchanged: throw new TypeError('Unchanged rows do not create Quick Diff decorations');
	}
}

function kindPriority(kind: QuickDiffDecorationMetadata['kind']): number {
	switch (kind) {
		case LineDiffKind.Removed: return 3;
		case LineDiffKind.Modified: return 2;
		case LineDiffKind.Added: return 1;
	}
}

function classNameForKind(kind: QuickDiffDecorationMetadata['kind']): string {
	switch (kind) {
		case LineDiffKind.Added: return 'ash-quick-diff-added';
		case LineDiffKind.Modified: return 'ash-quick-diff-modified';
		case LineDiffKind.Removed: return 'ash-quick-diff-deleted';
	}
}

function colorForKind(kind: QuickDiffDecorationMetadata['kind']): string {
	switch (kind) {
		case LineDiffKind.Added: return ColorId.diffEditorInsertedLineMarker;
		case LineDiffKind.Modified: return ColorId.warningForeground;
		case LineDiffKind.Removed: return ColorId.diffEditorRemovedLineMarker;
	}
}

function hoverText(metadata: QuickDiffDecorationMetadata): string {
	const kind = metadata.kind === LineDiffKind.Added
		? 'Added'
		: metadata.kind === LineDiffKind.Modified ? 'Modified' : 'Deleted';
	return `${kind} relative to ${metadata.providerLabels.join(', ')}`;
}
