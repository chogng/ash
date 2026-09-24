import { Disposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type TrackedRange } from '../../../common/model/trackedRange.js';

/** Owns search highlights and tracked selection scopes for one editor model. */
export class FindDecorations extends Disposable {
	public static readonly _FIND_MATCH_DECORATION = { description: 'find-match', className: 'findMatch' };
	public static readonly _CURRENT_FIND_MATCH_DECORATION = { description: 'current-find-match', className: 'currentFindMatch' };

	private readonly model: TextModel;
	private readonly matches: TextDecorationCollection<void>;
	private scopes: TrackedRange[] = [];
	private startPosition: Position;
	private currentMatch: Range | null = null;

	constructor(editor: ICodeEditor) {
		super();
		this.model = editor.getModel() as TextModel;
		this.matches = this._register(new TextDecorationCollection<void>(this.model));
		this.startPosition = Position.lift(editor.getPosition() ?? new Position(1, 1));
	}

	public override dispose(): void {
		this.reset();
		super.dispose();
	}

	public reset(): void {
		this.matches.clear();
		for (const scope of this.scopes) scope.dispose();
		this.scopes = [];
		this.currentMatch = null;
	}

	public getCount(): number { return this.matches.size; }
	public getFindScope(): Range | null { return this.getFindScopes()?.[0] ?? null; }
	public getFindScopes(): Range[] | null { return this.scopes.length ? this.scopes.map(scope => scope.range) : null; }
	public getStartPosition(): Position { return this.startPosition; }
	public setStartPosition(position: Position): void {
		this.startPosition = position;
		this.currentMatch = null;
	}
	public getDecorationRangeAt(index: number): Range | null { return this.matches.decorations[index]?.range ?? null; }

	public getCurrentMatchesPosition(selection: Range): number {
		return this.matches.decorations.findIndex(item => Range.equalsRange(item.range, selection)) + 1;
	}

	public setCurrentFindMatch(range: Range | null): number {
		const previousIndex = this.currentMatch ? this.getCurrentMatchesPosition(this.currentMatch) - 1 : -1;
		const nextIndex = range ? this.getCurrentMatchesPosition(range) - 1 : -1;
		if (previousIndex === nextIndex) return nextIndex + 1;
		const snapshots = this.matches.decorations;
		const previous = snapshots[previousIndex];
		if (previous) this.matches.update(previous.id, {
			range: previous.range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: FindDecorations._FIND_MATCH_DECORATION,
			metadata: undefined,
		});
		const next = snapshots[nextIndex];
		if (next) this.matches.update(next.id, {
			range: next.range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: FindDecorations._CURRENT_FIND_MATCH_DECORATION,
			metadata: undefined,
		});
		this.currentMatch = range;
		return nextIndex + 1;
	}

	public set(findMatches: readonly { readonly range: Range }[], findScopes: Range[] | null): void {
		this.matches.replaceAll(findMatches.map(match => ({
			range: match.range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: FindDecorations._FIND_MATCH_DECORATION,
			metadata: undefined,
		})));
		for (const scope of this.scopes) scope.dispose();
		this.scopes = findScopes?.map(range => this.model.trackRange(range, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges)) ?? [];
		this.currentMatch = null;
	}

	public matchBeforePosition(position: Position): Range | null {
		const ranges = this.matches.decorations.map(item => item.range);
		if (!ranges.length) return null;
		for (let index = ranges.length - 1; index >= 0; index--) {
			if (Position.compare(ranges[index]!.getEndPosition(), position) <= 0) return ranges[index]!;
		}
		return ranges[ranges.length - 1]!;
	}

	public matchAfterPosition(position: Position): Range | null {
		const ranges = this.matches.decorations.map(item => item.range);
		if (!ranges.length) return null;
		return ranges.find(range => Position.compare(range.getStartPosition(), position) >= 0) ?? ranges[0]!;
	}
}
