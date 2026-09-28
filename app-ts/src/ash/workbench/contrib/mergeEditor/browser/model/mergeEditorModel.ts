import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import type { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import type { IDocumentDiff, IDocumentDiffProvider } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { IDiffService } from '../../../../services/diff/common/diffService.js';

export type MergeEditorSide = 'base' | 'current' | 'incoming' | 'result';
export type MergeEditorChoice = 'base' | 'current' | 'incoming' | 'both' | 'bothReversed';
export type MergeEditorResolution = 'unresolved' | 'base' | 'current' | 'incoming' | 'both' | 'bothReversed' | 'manual';

export interface MergeEditorHunk {
	readonly index: number;
	readonly base: LineRange;
	readonly current: LineRange;
	readonly incoming: LineRange;
	readonly result: LineRange;
	readonly unresolved: boolean;
	readonly resolution: MergeEditorResolution;
}

interface SourceHunk {
	readonly base: LineRange;
	readonly current: LineRange;
	readonly incoming: LineRange;
}

const diffOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false } as const;

/** The three immutable inputs own conflict identity; the file-backed result supplies its current mapping. */
export class MergeEditorModel extends Disposable {
	public readonly base: TextModel;
	public readonly current: TextModel;
	public readonly incoming: TextModel;
	private readonly diffComputer: IDocumentDiffProvider & IDisposable;
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChange = this.changeEmitter.event;
	private currentChanges: readonly DetailedLineRangeMapping[] = [];
	private incomingChanges: readonly DetailedLineRangeMapping[] = [];
	private resultChanges: readonly DetailedLineRangeMapping[] = [];
	private sourceHunks: readonly SourceHunk[] = [];
	private hunksValue: readonly MergeEditorHunk[] = [];
	private resultRequest: CancellationTokenSource | undefined;
	private generation = 0;
	private ready = false;
	private errorValue: Error | undefined;

	constructor(
		base: string,
		current: string,
		incoming: string,
		public readonly result: TextModel,
		@IDiffService private readonly diffService: IDiffService,
	) {
		super();
		this.diffComputer = this._register(this.diffService.createComputationService());
		const languageId = result.getLanguageId();
		this.base = this._register(new TextModel(base, { languageId }));
		this.current = this._register(new TextModel(current, { languageId }));
		this.incoming = this._register(new TextModel(incoming, { languageId }));
		this._register(result.onDidChangeLanguage(() => {
			const language = result.getLanguageId();
			this.base.setLanguage(language);
			this.current.setLanguage(language);
			this.incoming.setLanguage(language);
		}));
		this._register(toDisposable(() => this.resultRequest?.dispose(true)));
	}

	public get hunks(): readonly MergeEditorHunk[] { return this.hunksValue; }
	public get unresolvedCount(): number { return this.hunksValue.filter(hunk => hunk.unresolved).length; }
	public get isReady(): boolean { return this.ready; }
	public get error(): Error | undefined { return this.errorValue; }
	public getChanges(side: Exclude<MergeEditorSide, 'base'>): readonly DetailedLineRangeMapping[] { return this.changesFor(side); }

	public async initialize(signal: AbortSignal): Promise<void> {
		const request = new CancellationTokenSource();
		this.resultRequest = request;
		const abort = (): void => request.cancel();
		signal.addEventListener('abort', abort, { once: true });
		try {
			if (signal.aborted) request.cancel();
			const resultVersion = this.result.getVersionId();
			const [current, incoming, result] = await Promise.all([
				this.diffComputer.computeDiff(this.base, this.current, diffOptions, request.token),
				this.diffComputer.computeDiff(this.base, this.incoming, diffOptions, request.token),
				this.diffComputer.computeDiff(this.base, this.result, diffOptions, request.token),
			]);
			if (signal.aborted || this.isDisposed) return;
			this.currentChanges = completeChanges(current);
			this.incomingChanges = completeChanges(incoming);
			this.resultChanges = completeChanges(result);
			this.sourceHunks = buildSourceHunks(this.base, this.current, this.incoming, this.currentChanges, this.incomingChanges);
			this._register(this.result.onDidChangeContent(() => void this.refreshResult()));
			if (this.result.getVersionId() !== resultVersion) await this.refreshResult();
			else {
				this.ready = true;
				this.updateHunks();
			}
		} finally {
			signal.removeEventListener('abort', abort);
			if (this.resultRequest === request) this.resultRequest = undefined;
			request.dispose();
		}
	}

	private async refreshResult(): Promise<void> {
		this.resultRequest?.dispose(true);
		const request = new CancellationTokenSource();
		this.resultRequest = request;
		const generation = ++this.generation;
		this.ready = false;
		this.errorValue = undefined;
		this.changeEmitter.fire();
		try {
			const version = this.result.getVersionId();
			const diff = await this.diffComputer.computeDiff(this.base, this.result, diffOptions, request.token);
			if (this.isDisposed || this.resultRequest !== request || generation !== this.generation || this.result.getVersionId() !== version) return;
			this.resultChanges = completeChanges(diff);
			this.ready = true;
			this.updateHunks();
		} catch (error) {
			if (!request.token.isCancellationRequested && !this.isDisposed) {
				this.ready = false;
				this.errorValue = error instanceof Error ? error : new Error(String(error));
				this.changeEmitter.fire();
			}
		} finally {
			if (this.resultRequest === request) this.resultRequest = undefined;
			request.dispose();
		}
	}

	private updateHunks(): void {
		this.hunksValue = this.sourceHunks.map((source, index) => {
			const result = mapRange(source.base, this.resultChanges);
			const hunk = {
				...source,
				index,
				result,
			};
			const resolution = this.classifyHunk(hunk);
			return { ...hunk, resolution, unresolved: resolution === 'unresolved' };
		});
		this.changeEmitter.fire();
	}

	private classifyHunk(hunk: SourceHunk & { readonly result: LineRange }): MergeEditorResolution {
		const result = textInRange(this.result, hunk.result);
		if (/^(?:<{7}|={7}|>{7})/m.test(result)) return 'unresolved';
		for (const side of ['current', 'incoming', 'base'] as const) {
			if (result === textInRange(this[side], hunk[side])) return side;
		}
		const current = textInRange(this.current, hunk.current);
		const incoming = textInRange(this.incoming, hunk.incoming);
		if (result === this.smartCombine(hunk, current, incoming) || result === current + incoming) return 'both';
		if (result === incoming + current) return 'bothReversed';
		return 'manual';
	}

	public editForHunk(index: number, choice: MergeEditorChoice): { range: Range; text: string } {
		if (!this.ready) throw new Error('Merge differences are still computing');
		const hunk = this.hunksValue[index];
		if (!hunk) throw new RangeError('Merge conflict does not exist');
		const current = textInRange(this.current, hunk.current);
		const incoming = textInRange(this.incoming, hunk.incoming);
		let text: string;
		switch (choice) {
			case 'base': text = textInRange(this.base, hunk.base); break;
			case 'current': text = current; break;
			case 'incoming': text = incoming; break;
			case 'both': text = this.smartCombine(hunk, current, incoming) ?? current + incoming; break;
			case 'bothReversed': text = this.smartCombine(hunk, current, incoming) ?? incoming + current; break;
		}
		return { range: rangeInModel(this.result, hunk.result), text };
	}

	public canSmartCombine(index: number): boolean {
		const hunk = this.hunksValue[index];
		return Boolean(hunk && this.smartCombine(hunk, textInRange(this.current, hunk.current), textInRange(this.incoming, hunk.incoming)) !== undefined);
	}

	private smartCombine(hunk: SourceHunk, current: string, incoming: string): string | undefined {
		const baseText = textInRange(this.base, hunk.base);
		const currentEdits = characterEdits(this.base, this.current, hunk.base, this.currentChanges);
		const incomingEdits = characterEdits(this.base, this.incoming, hunk.base, this.incomingChanges);
		if (!currentEdits || !incomingEdits || applyCharacterEdits(baseText, currentEdits) !== current || applyCharacterEdits(baseText, incomingEdits) !== incoming) return undefined;
		const combined = [...currentEdits, ...incomingEdits].sort((left, right) => left.start - right.start || left.end - right.end);
		for (let index = 1; index < combined.length; index++) {
			const previous = combined[index - 1];
			const next = combined[index];
			if (previous.end > next.start || (previous.start === next.start && previous.end === next.end)) return undefined;
		}
		return applyCharacterEdits(baseText, combined);
	}

	public mapLine(source: MergeEditorSide, target: MergeEditorSide, lineNumber: number): number {
		const baseLine = source === 'base' ? lineNumber : mapBoundary(lineNumber, this.changesFor(source).map(change => change.flip()), 'start');
		return target === 'base' ? baseLine : mapBoundary(baseLine, this.changesFor(target), 'start');
	}

	private changesFor(side: Exclude<MergeEditorSide, 'base'>): readonly DetailedLineRangeMapping[] {
		switch (side) {
			case 'current': return this.currentChanges;
			case 'incoming': return this.incomingChanges;
			case 'result': return this.resultChanges;
		}
	}
}

function completeChanges(diff: IDocumentDiff): readonly DetailedLineRangeMapping[] {
	if (diff.quitEarly) throw new Error('Merge difference computation did not finish');
	return diff.changes;
}

function buildSourceHunks(base: TextModel, current: TextModel, incoming: TextModel, currentChanges: readonly DetailedLineRangeMapping[], incomingChanges: readonly DetailedLineRangeMapping[]): readonly SourceHunk[] {
	const changes = [...currentChanges.map(change => ({ range: change.original, side: 'current' as const })), ...incomingChanges.map(change => ({ range: change.original, side: 'incoming' as const }))]
		.sort((left, right) => left.range.startLineNumber - right.range.startLineNumber || left.range.endLineNumberExclusive - right.range.endLineNumberExclusive);
	const groups: { base: LineRange; currentChanged: boolean; incomingChanged: boolean }[] = [];
	for (const change of changes) {
		const last = groups.at(-1);
		if (last && last.base.endLineNumberExclusive >= change.range.startLineNumber) {
			last.base = last.base.join(change.range);
			if (change.side === 'current') last.currentChanged = true;
			else last.incomingChanged = true;
		} else {
			groups.push({ base: change.range, currentChanged: change.side === 'current', incomingChanged: change.side === 'incoming' });
		}
	}
	return groups.filter(group => group.currentChanged && group.incomingChanged).map(group => ({
		base: group.base,
		current: mapRange(group.base, currentChanges),
		incoming: mapRange(group.base, incomingChanges),
	})).filter(hunk => textInRange(current, hunk.current) !== textInRange(incoming, hunk.incoming) || textInRange(base, hunk.base) === '');
}

function mapRange(range: LineRange, changes: readonly DetailedLineRangeMapping[]): LineRange {
	return new LineRange(mapBoundary(range.startLineNumber, changes, 'start'), mapBoundary(range.endLineNumberExclusive, changes, 'end'));
}

function mapBoundary(lineNumber: number, changes: readonly DetailedLineRangeMapping[], edge: 'start' | 'end'): number {
	let delta = 0;
	for (const change of changes) {
		const original = change.original;
		const modified = change.modified;
		if (original.endLineNumberExclusive < lineNumber || (original.endLineNumberExclusive === lineNumber && (edge === 'end' || original.startLineNumber < lineNumber))) {
			delta = modified.endLineNumberExclusive - original.endLineNumberExclusive;
			continue;
		}
		if (original.startLineNumber < lineNumber && lineNumber < original.endLineNumberExclusive) {
			return edge === 'start' ? modified.startLineNumber : modified.endLineNumberExclusive;
		}
		break;
	}
	return lineNumber + delta;
}

function rangeInModel(model: TextModel, lines: LineRange): Range {
	return Range.fromPositions(model.positionAt(lineOffset(model, lines.startLineNumber)), model.positionAt(lineOffset(model, lines.endLineNumberExclusive)));
}

function textInRange(model: TextModel, lines: LineRange): string {
	return model.getValueInRange(rangeInModel(model, lines));
}

function lineOffset(model: TextModel, lineNumber: number): number {
	return lineNumber > model.getLineCount() ? model.getValue().length : model.getOffsetAt(new Position(lineNumber, 1));
}

interface CharacterEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

function characterEdits(base: TextModel, side: TextModel, hunk: LineRange, changes: readonly DetailedLineRangeMapping[]): readonly CharacterEdit[] | undefined {
	const baseOffset = lineOffset(base, hunk.startLineNumber);
	const edits: CharacterEdit[] = [];
	for (const change of changes) {
		if (change.original.endLineNumberExclusive < hunk.startLineNumber || change.original.startLineNumber > hunk.endLineNumberExclusive) continue;
		if (!hunk.containsRange(change.original) || !change.innerChanges) return undefined;
		for (const inner of change.innerChanges) {
			edits.push({
				start: base.getOffsetAt(inner.originalRange.getStartPosition()) - baseOffset,
				end: base.getOffsetAt(inner.originalRange.getEndPosition()) - baseOffset,
				text: side.getValueInRange(inner.modifiedRange),
			});
		}
	}
	return edits;
}

function applyCharacterEdits(base: string, edits: readonly CharacterEdit[]): string {
	let result = base;
	for (const edit of [...edits].sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	return result;
}
