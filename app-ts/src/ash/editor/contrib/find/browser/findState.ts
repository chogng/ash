import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../common/core/range.js';

export interface FindReplaceStateChangedEvent {
	moveCursor: boolean;
	updateHistory: boolean;
	searchString: boolean;
	replaceString: boolean;
	isRevealed: boolean;
	isReplaceRevealed: boolean;
	isRegex: boolean;
	wholeWord: boolean;
	matchCase: boolean;
	preserveCase: boolean;
	searchScope: boolean;
	matchesPosition: boolean;
	matchesCount: boolean;
	currentMatch: boolean;
	loop: boolean;
	isSearching: boolean;
	filters: boolean;
}

export const enum FindOptionOverride {
	NotSet = 0,
	True = 1,
	False = 2,
}

export interface INewFindReplaceState<T extends { update(value: T): void } = { update(): void }> {
	searchString?: string;
	replaceString?: string;
	isRevealed?: boolean;
	isReplaceRevealed?: boolean;
	isRegex?: boolean;
	isRegexOverride?: FindOptionOverride;
	wholeWord?: boolean;
	wholeWordOverride?: FindOptionOverride;
	matchCase?: boolean;
	matchCaseOverride?: FindOptionOverride;
	preserveCase?: boolean;
	preserveCaseOverride?: FindOptionOverride;
	searchScope?: Range[] | null;
	loop?: boolean;
	isSearching?: boolean;
	filters?: T;
}

interface FindValues<T> {
	searchString: string;
	replaceString: string;
	isRevealed: boolean;
	isReplaceRevealed: boolean;
	isRegex: boolean;
	wholeWord: boolean;
	matchCase: boolean;
	preserveCase: boolean;
	searchScope: Range[] | null;
	loop: boolean;
	isSearching: boolean;
	filters: T | null;
}

interface FindOverrides {
	isRegex: FindOptionOverride;
	wholeWord: FindOptionOverride;
	matchCase: FindOptionOverride;
	preserveCase: FindOptionOverride;
}

const MATCHES_LIMIT = 19_999;

export class FindReplaceState<T extends { update(value: T): void } = { update(): void }> extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<FindReplaceStateChangedEvent>());
	private readonly values: FindValues<T> = {
		searchString: '',
		replaceString: '',
		isRevealed: false,
		isReplaceRevealed: false,
		isRegex: false,
		wholeWord: false,
		matchCase: false,
		preserveCase: false,
		searchScope: null,
		loop: true,
		isSearching: false,
		filters: null,
	};
	private overrides: FindOverrides = {
		isRegex: FindOptionOverride.NotSet,
		wholeWord: FindOptionOverride.NotSet,
		matchCase: FindOptionOverride.NotSet,
		preserveCase: FindOptionOverride.NotSet,
	};
	private matchPosition = 0;
	private matchCount = 0;
	private matchRange: Range | null = null;

	public readonly onFindReplaceStateChange: Event<FindReplaceStateChangedEvent> = this.changeEmitter.event;

	public get searchString(): string { return this.values.searchString; }
	public get replaceString(): string { return this.values.replaceString; }
	public get isRevealed(): boolean { return this.values.isRevealed; }
	public get isReplaceRevealed(): boolean { return this.values.isReplaceRevealed; }
	public get isRegex(): boolean { return effective(this.values.isRegex, this.overrides.isRegex); }
	public get wholeWord(): boolean { return effective(this.values.wholeWord, this.overrides.wholeWord); }
	public get matchCase(): boolean { return effective(this.values.matchCase, this.overrides.matchCase); }
	public get preserveCase(): boolean { return effective(this.values.preserveCase, this.overrides.preserveCase); }
	public get actualIsRegex(): boolean { return this.values.isRegex; }
	public get actualWholeWord(): boolean { return this.values.wholeWord; }
	public get actualMatchCase(): boolean { return this.values.matchCase; }
	public get actualPreserveCase(): boolean { return this.values.preserveCase; }
	public get searchScope(): Range[] | null { return this.values.searchScope; }
	public get matchesPosition(): number { return this.matchPosition; }
	public get matchesCount(): number { return this.matchCount; }
	public get currentMatch(): Range | null { return this.matchRange; }
	public get isSearching(): boolean { return this.values.isSearching; }
	public get loop(): boolean { return this.values.loop; }
	public get filters(): T | null { return this.values.filters; }

	public changeMatchInfo(matchesPosition: number, matchesCount: number, currentMatch: Range | undefined): void {
		const count = Math.max(0, matchesCount);
		const position = Math.max(0, Math.min(matchesPosition, count));
		const nextRange = currentMatch ?? (count === 0 ? null : this.matchRange);
		const event = createEvent(false, false);
		event.matchesPosition = position !== this.matchPosition;
		event.matchesCount = count !== this.matchCount;
		event.currentMatch = !Range.equalsRange(nextRange, this.matchRange);
		if (!event.matchesPosition && !event.matchesCount && !event.currentMatch) return;
		this.matchPosition = position;
		this.matchCount = count;
		this.matchRange = nextRange;
		this.changeEmitter.fire(event);
	}

	public change(next: INewFindReplaceState<T>, moveCursor: boolean, updateHistory = true): void {
		const before = {
			isRegex: this.isRegex,
			wholeWord: this.wholeWord,
			matchCase: this.matchCase,
			preserveCase: this.preserveCase,
		};
		const event = createEvent(moveCursor, updateHistory);
		const updateScalar = <K extends 'searchString' | 'replaceString' | 'isRevealed' | 'isReplaceRevealed' | 'loop' | 'isSearching'>(
			key: K,
			value: FindValues<T>[K] | undefined,
		): void => {
			if (value !== undefined && value !== this.values[key]) {
				this.values[key] = value;
				event[key] = true;
			}
		};
		updateScalar('searchString', next.searchString);
		updateScalar('replaceString', next.replaceString);
		updateScalar('isRevealed', next.isRevealed);
		updateScalar('isReplaceRevealed', next.isReplaceRevealed);
		updateScalar('loop', next.loop);
		updateScalar('isSearching', next.isSearching);
		for (const key of ['isRegex', 'wholeWord', 'matchCase', 'preserveCase'] as const) {
			if (next[key] !== undefined) this.values[key] = next[key];
			this.overrides[key] = next[`${key}Override`] ?? FindOptionOverride.NotSet;
			event[key] = before[key] !== this[key];
		}
		if (next.searchScope !== undefined && !sameScopes(this.values.searchScope, next.searchScope)) {
			this.values.searchScope = next.searchScope;
			event.searchScope = true;
		}
		if (next.filters !== undefined) {
			if (this.values.filters) this.values.filters.update(next.filters);
			else this.values.filters = next.filters;
			event.filters = true;
		}
		if (changed(event)) this.changeEmitter.fire(event);
	}

	public canNavigateBack(): boolean {
		return this.values.loop || this.matchCount >= MATCHES_LIMIT || this.matchPosition !== 1;
	}

	public canNavigateForward(): boolean {
		return this.values.loop || this.matchCount >= MATCHES_LIMIT || this.matchPosition < this.matchCount;
	}
}

function effective(value: boolean, override: FindOptionOverride): boolean {
	return override === FindOptionOverride.NotSet ? value : override === FindOptionOverride.True;
}

function sameScopes(left: readonly Range[] | null, right: readonly Range[] | null): boolean {
	return left === right || (left !== null && right !== null && left.length === right.length && left.every((range, index) => Range.equalsRange(range, right[index])));
}

function createEvent(moveCursor: boolean, updateHistory: boolean): FindReplaceStateChangedEvent {
	return {
		moveCursor,
		updateHistory,
		searchString: false,
		replaceString: false,
		isRevealed: false,
		isReplaceRevealed: false,
		isRegex: false,
		wholeWord: false,
		matchCase: false,
		preserveCase: false,
		searchScope: false,
		matchesPosition: false,
		matchesCount: false,
		currentMatch: false,
		loop: false,
		isSearching: false,
		filters: false,
	};
}

function changed(event: FindReplaceStateChangedEvent): boolean {
	return event.searchString || event.replaceString || event.isRevealed || event.isReplaceRevealed ||
		event.isRegex || event.wholeWord || event.matchCase || event.preserveCase ||
		event.searchScope || event.loop || event.isSearching || event.filters;
}
