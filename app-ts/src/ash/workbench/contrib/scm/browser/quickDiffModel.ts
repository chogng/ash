import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../../editor/common/diff/documentDiffProvider.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DiffModel } from '../../../../editor/common/diff/diffModel.js';
import { LineDiffKind, type LineDiff, type LineDiffHunk, type LineDiffRow } from '../../../../editor/common/diff/lineDiff.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { type IQuickDiffModel, type IQuickDiffModelService, type IQuickDiffService, type QuickDiffChange, type QuickDiffComparison, type QuickDiffModelReference, type QuickDiffModelState } from '../common/quickDiff.js';
import { type IDiffService } from '../../../services/diff/common/diffService.js';
import { CodeEditorConfiguration } from '../../codeEditor/common/editorConfiguration.js';
import { ScmConfiguration, type ScmDiffDecorationsIgnoreTrimWhitespace } from '../common/scmConfiguration.js';

interface SharedModelEntry {
	readonly resource: URI;
	readonly model: TextModel;
	readonly quickDiffModel: QuickDiffModel;
	references: number;
}

const QUICK_DIFF_MAX_COMPUTATION_TIME_MS = 1_000;

/** Reference-counted owner of Quick Diff models shared by decorations and editor controllers. */
export class QuickDiffModelService extends Disposable implements IQuickDiffModelService {
	private readonly entries = new WeakMap<TextModel, SharedModelEntry>();
	private readonly liveEntries = new Set<SharedModelEntry>();

	constructor(private readonly quickDiffService: IQuickDiffService, private readonly diffService: IDiffService, @IConfigurationService private readonly configuration: IConfigurationService) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.liveEntries) entry.quickDiffModel.dispose();
			this.liveEntries.clear();
		}));
	}

	createModelReference(resource: URI, model: TextModel): QuickDiffModelReference {
		this.assertNotDisposed();
		let entry = this.entries.get(model);
		if (entry && entry.resource.toString() !== resource.toString()) {
			throw new Error('A text model cannot be shared by different Quick Diff resources');
		}
		if (!entry) {
			entry = { resource, model, quickDiffModel: new QuickDiffModel(resource, model, this.diffService, this.quickDiffService, this.configuration), references: 0 };
			this.entries.set(model, entry);
			this.liveEntries.add(entry);
		}
		entry.references += 1;
		const disposable = toDisposable(() => this.release(entry!));
		return Object.freeze({
			object: entry.quickDiffModel,
			dispose: () => disposable.dispose(),
			[Symbol.dispose]: () => disposable.dispose(),
		});
	}

	private release(entry: SharedModelEntry): void {
		if (!this.liveEntries.has(entry)) return;
		entry.references -= 1;
		if (entry.references > 0) return;
		this.entries.delete(entry.model);
		this.liveEntries.delete(entry);
		entry.quickDiffModel.dispose();
	}
}

/** Shared resource model that owns provider originals and live DiffModels. */
export class QuickDiffModel extends Disposable implements IQuickDiffModel {
	private readonly changeEmitter = this._register(new Emitter<QuickDiffModelState>());
	private readonly diffProvider: IDocumentDiffProvider;
	private readonly comparisonStore = this._register(new MutableDisposable<DisposableStore>());
	private activeRequest: AbortController | undefined;
	private requestGeneration = 0;
	private _state: QuickDiffModelState = Object.freeze({ loading: true, comparisons: Object.freeze([]), changes: Object.freeze([]) });

	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly resource: URI, private readonly modified: TextModel, diffService: IDiffService, private readonly quickDiffService: IQuickDiffService, private readonly configuration: IConfigurationService) {
		super();
		this.diffProvider = this._register(diffService.createComputationService());
		this._register(configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(ScmConfiguration.diffDecorationsIgnoreTrimWhitespace)
				&& !event.affectsConfiguration(
					CodeEditorConfiguration.diffIgnoreTrimWhitespace,
					{ overrideIdentifier: modified.getLanguageId() },
				)) return;
			const options = this.diffOptions();
			for (const comparison of this._state.comparisons) comparison.model.updateOptions(options);
		}));
		this._register(modified.onDidChangeLanguage(() => {
			const options = this.diffOptions();
			for (const comparison of this._state.comparisons) comparison.model.updateOptions(options);
		}));
		this._register(quickDiffService.onDidChange(changedResource => {
			if (!changedResource || changedResource.toString() === resource.toString()) void this.refresh();
		}));
		this._register(toDisposable(() => {
			this.activeRequest?.abort('quickDiffModelDisposed');
			this.activeRequest = undefined;
		}));
		void this.refresh();
	}

	get state(): QuickDiffModelState {
		return this._state;
	}

	async refresh(): Promise<void> {
		if (this.isDisposed) return;
		this.activeRequest?.abort('quickDiffModelSuperseded');
		const controller = new AbortController();
		this.activeRequest = controller;
		const generation = ++this.requestGeneration;
		this.setState(Object.freeze({ ...this._state, loading: true }));
		try {
			const originals = await this.quickDiffService.getQuickDiffs(this.resource, controller.signal);
			if (this.isDisposed || controller.signal.aborted || generation !== this.requestGeneration) return;
			const store = new DisposableStore();
			const comparisons: QuickDiffComparison[] = [];
			try {
				for (const original of originals) {
					const originalModel = store.add(new TextModel(original.text));
					const diffModel = store.add(new DiffModel({ original: originalModel, modified: this.modified, diffProvider: this.diffProvider, diffOptions: this.diffOptions() }));
					const comparison = Object.freeze({ original, model: diffModel });
					comparisons.push(comparison);
					store.add(diffModel.onDidChange(() => this.rebuildChanges()));
				}
			} catch (error) {
				store.dispose();
				throw error;
			}
			this.comparisonStore.value = store;
			this._state = Object.freeze({ loading: false, comparisons: Object.freeze(comparisons), changes: Object.freeze([]) });
			this.rebuildChanges();
		} catch (error) {
			if (controller.signal.aborted || this.isDisposed || generation !== this.requestGeneration) return;
			this.setState(Object.freeze({ ...this._state, loading: false }));
			void error;
		} finally {
			if (this.activeRequest === controller) this.activeRequest = undefined;
		}
	}

	findChangeAtLine(lineIndex: number): QuickDiffChange | undefined {
		validateLineIndex(lineIndex);
		return this._state.changes.find(change => {
			const rows = change.comparison.model.diff?.rows;
			if (!rows) return false;
			for (let rowIndex = change.rowStart; rowIndex < change.rowEnd; rowIndex += 1) {
				const row = rows[rowIndex];
				if (row && (row.modifiedLineIndex ?? deletionAnchor(rows, rowIndex, this.modified.lineCount)) === lineIndex) return true;
			}
			return false;
		});
	}

	private diffOptions(): IDocumentDiffProviderOptions {
		const setting = this.configuration.getValue<ScmDiffDecorationsIgnoreTrimWhitespace>(ScmConfiguration.diffDecorationsIgnoreTrimWhitespace);
		return {
			ignoreTrimWhitespace: setting === 'inherit'
				? this.configuration.getValue<boolean>(
					CodeEditorConfiguration.diffIgnoreTrimWhitespace,
					{ overrideIdentifier: this.modified.getLanguageId() },
				)
				: setting === 'true',
			maxComputationTimeMs: QUICK_DIFF_MAX_COMPUTATION_TIME_MS,
			computeMoves: false,
		};
	}

	findNextChange(lineIndex: number, inclusive = false): QuickDiffChange | undefined {
		validateLineIndex(lineIndex);
		const changes = this._state.changes;
		return changes.find(change => inclusive ? change.lineIndex >= lineIndex : change.lineIndex > lineIndex) ?? changes[0];
	}

	findPreviousChange(lineIndex: number, inclusive = false): QuickDiffChange | undefined {
		validateLineIndex(lineIndex);
		const changes = this._state.changes;
		return [...changes].reverse().find(change => inclusive ? change.lineIndex <= lineIndex : change.lineIndex < lineIndex) ?? changes[changes.length - 1];
	}

	private rebuildChanges(): void {
		if (this.isDisposed) return;
		const changes = this._state.comparisons.flatMap(comparison => changesForComparison(comparison, this.modified.lineCount));
		changes.sort((left, right) => left.lineIndex - right.lineIndex);
		this.setState(Object.freeze({ ...this._state, changes: Object.freeze(changes) }));
	}

	private setState(state: QuickDiffModelState): void {
		this._state = state;
		this.changeEmitter.fire(state);
	}
}

function changesForComparison(comparison: QuickDiffComparison, modifiedLineCount: number): QuickDiffChange[] {
	const diff = comparison.model.diff;
	if (!diff) return [];
	return hunksOf(diff).map((hunk, hunkIndex) => {
		const rows = diff.rows.slice(hunk.rowStart, hunk.rowEnd);
		const lineIndex = firstModifiedLine(rows) ?? deletionAnchor(diff.rows, hunk.rowStart, modifiedLineCount);
		return Object.freeze({
			id: `${comparison.original.providerId}:${comparison.original.revision}:${hunkIndex}:${hunk.rowStart}:${hunk.rowEnd}`,
			comparison,
			kind: hunkKind(rows),
			...hunk,
			lineIndex,
		});
	});
}

function hunksOf(diff: LineDiff): readonly LineDiffHunk[] {
	if (diff.hunks.length > 0) return diff.hunks;
	const hunks: LineDiffHunk[] = [];
	let rowStart = -1;
	for (let rowIndex = 0; rowIndex <= diff.rows.length; rowIndex += 1) {
		const changed = rowIndex < diff.rows.length && diff.rows[rowIndex]!.kind !== LineDiffKind.Unchanged;
		if (changed && rowStart < 0) rowStart = rowIndex;
		if (changed || rowStart < 0) continue;
		const rows = diff.rows.slice(rowStart, rowIndex);
		const originalLines = rows.flatMap(row => row.originalLineIndex === undefined ? [] : [row.originalLineIndex]);
		const modifiedLines = rows.flatMap(row => row.modifiedLineIndex === undefined ? [] : [row.modifiedLineIndex]);
		hunks.push(Object.freeze({
			rowStart,
			rowEnd: rowIndex,
			originalStartLineIndex: originalLines[0] ?? nearestOriginalLine(diff.rows, rowStart),
			originalLineCount: originalLines.length,
			modifiedStartLineIndex: modifiedLines[0] ?? nearestModifiedLine(diff.rows, rowStart),
			modifiedLineCount: modifiedLines.length,
		}));
		rowStart = -1;
	}
	return Object.freeze(hunks);
}

function hunkKind(rows: readonly LineDiffRow[]): Exclude<LineDiffKind, LineDiffKind.Unchanged> {
	if (rows.every(row => row.kind === LineDiffKind.Added)) return LineDiffKind.Added;
	if (rows.every(row => row.kind === LineDiffKind.Removed)) return LineDiffKind.Removed;
	return LineDiffKind.Modified;
}

function firstModifiedLine(rows: readonly LineDiffRow[]): number | undefined {
	return rows.find(row => row.modifiedLineIndex !== undefined)?.modifiedLineIndex;
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

function nearestOriginalLine(rows: readonly LineDiffRow[], rowIndex: number): number {
	return nearestLine(rows, rowIndex, 'originalLineIndex');
}

function nearestModifiedLine(rows: readonly LineDiffRow[], rowIndex: number): number {
	return nearestLine(rows, rowIndex, 'modifiedLineIndex');
}

function nearestLine(rows: readonly LineDiffRow[], rowIndex: number, side: 'originalLineIndex' | 'modifiedLineIndex'): number {
	for (let index = rowIndex; index < rows.length; index += 1) {
		const lineIndex = rows[index]?.[side];
		if (lineIndex !== undefined) return lineIndex;
	}
	for (let index = rowIndex - 1; index >= 0; index -= 1) {
		const lineIndex = rows[index]?.[side];
		if (lineIndex !== undefined) return lineIndex + 1;
	}
	return 0;
}

function validateLineIndex(lineIndex: number): void {
	if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) throw new RangeError('Quick Diff line index must be a non-negative safe integer');
}
