import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { themeColorFromId } from '../../../../base/common/themables.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { LineDiffKind } from '../../../../editor/common/diff/lineDiff.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { type IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';

import { type IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { warningForeground } from '../../../../platform/theme/common/colors/baseColors.js';
import { diffInsertedLineMarker, diffRemovedLineMarker } from '../../../../platform/theme/common/colors/editorColors.js';
import { quickDiffDeletionAnchor, type QuickDiffComparison, type QuickDiffModelReference } from '../common/quickDiff.js';
import { MinimapPosition, OverviewRulerLane, TrackedRangeStickiness, type IModelDecorationOptions, type ITextModel } from '../../../../editor/common/model.js';

interface QuickDiffDecorationMetadata {
	readonly kind: LineDiffKind.Added | LineDiffKind.Modified | LineDiffKind.Removed;
	readonly providerLabels: readonly string[];
	readonly beforeFirstLine: boolean;
}

/** Projects one shared Quick Diff model into gutter, overview-ruler, and minimap decorations. */
export class QuickDiffDecorator extends Disposable {
	private readonly collection: IEditorDecorationsCollection;
	private readonly model: ITextModel;

	constructor(editor: ICodeEditor, modelReference: QuickDiffModelReference, private readonly configurationService: IConfigurationService) {
		super();
		this.model = editor.getModel()!;
		// A working copy can also be displayed in a diff. Keep Git markers local
		// to this editor so they cannot overlap the comparison's own indicators.
		this.collection = editor.createDecorationsCollection();
		this._register(toDisposable(() => this.collection.clear()));
		this._register(modelReference.object.onDidChange(() => this.rebuild(modelReference.object.state.comparisons)));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('scm.diffDecorations')) this.rebuild(modelReference.object.state.comparisons);
		}));
		this.rebuild(modelReference.object.state.comparisons);
	}

	private resolve(metadata: QuickDiffDecorationMetadata): Omit<IModelDecorationOptions, 'stickiness'> {
		const setting = this.configurationService.getValue('scm.diffDecorations');
		const gutter = setting === 'all' || setting === 'gutter';
		const color = themeColorFromId(colorForKind(metadata.kind));
		return {
			description: 'dirty-diff-decoration',
			isWholeLine: metadata.kind !== LineDiffKind.Removed,
			...(gutter ? {
				linesDecorationsClassName: `ash-quick-diff-gutter ${classNameForKind(metadata.kind)}${metadata.beforeFirstLine ? ' ash-quick-diff-before-first-line' : ''}`,
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
		const setting = this.configurationService.getValue('scm.diffDecorations');
		if (setting === 'none') {
			this.collection.clear();
			return;
		}
		const byLine = new Map<number, QuickDiffDecorationMetadata>();
		const lineCount = this.model.getLineCount();
		for (const comparison of comparisons) {
			const diff = comparison.model.diff;
			if (!diff) continue;
			const label = comparison.original.label;
			const add = (lineIndex: number, kind: QuickDiffDecorationMetadata['kind'], beforeFirstLine = false) => {
				const current = byLine.get(lineIndex);
				if (!current || kindPriority(kind) > kindPriority(current.kind)) {
					byLine.set(lineIndex, { kind, providerLabels: [label], beforeFirstLine });
				} else if (beforeFirstLine || !current.providerLabels.includes(label)) {
					byLine.set(lineIndex, {
						...current, beforeFirstLine: current.beforeFirstLine || beforeFirstLine,
						providerLabels: current.providerLabels.includes(label) ? current.providerLabels : [...current.providerLabels, label],
					});
				}
			};
			for (const hunk of diff.hunks) {
				let nextLineIndex = hunk.modifiedStartLineIndex;
				if (hunk.modifiedLineCount === 0) {
					add(quickDiffDeletionAnchor(nextLineIndex, lineCount), LineDiffKind.Removed, hunk.rowStart === 0);
					continue;
				}
				let inDeletedRun = false;
				for (let index = hunk.rowStart; index < hunk.rowEnd; index++) {
					const row = diff.rows.get(index)!;
					if (row.kind === LineDiffKind.Removed) {
						if (!inDeletedRun) add(quickDiffDeletionAnchor(nextLineIndex, lineCount), row.kind, index === 0);
						inDeletedRun = true;
					} else if (row.kind === LineDiffKind.Added || row.kind === LineDiffKind.Modified) {
						add(nextLineIndex++, row.kind);
						inDeletedRun = false;
					}
				}
			}
		}
		this.collection.set([...byLine.entries()].sort(([left], [right]) => left - right).map(([lineIndex, metadata]) => {
			const line = lineIndex + 1;
			return {
				range: Range.fromPositions(new Position(line, 1), new Position(line, metadata.beforeFirstLine ? 1 : this.model.getLineLength(line) + 1)),
				options: { ...this.resolve(metadata), stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
			};
		}));
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
		case LineDiffKind.Added: return diffInsertedLineMarker;
		case LineDiffKind.Modified: return warningForeground;
		case LineDiffKind.Removed: return diffRemovedLineMarker;
	}
}

function hoverText(metadata: QuickDiffDecorationMetadata): string {
	const kind = metadata.kind === LineDiffKind.Added
		? 'Added'
		: metadata.kind === LineDiffKind.Modified ? 'Modified' : 'Deleted';
	return `${kind} relative to ${metadata.providerLabels.join(', ')}`;
}
