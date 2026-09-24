import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { rot } from '../../../../base/common/numbers.js';
import { RawContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { ReplaceCommand } from '../../../common/commands/replaceCommand.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { findTextMatches, TextSearchPatternKind, TextSearchQueryError, type TextSearchMatch, type TextModelSearchQuery } from '../../../common/model/textModelSearch.js';
import { FindDecorations } from './findDecorations.js';
import { FindReplaceState } from './findState.js';
import { ReplaceAllCommand } from './replaceAllCommand.js';
import { parseReplaceString, ReplacePattern } from './replacePattern.js';

export const CONTEXT_FIND_WIDGET_VISIBLE = new RawContextKey<boolean>('findWidgetVisible', false);
export const CONTEXT_FIND_WIDGET_NOT_VISIBLE = ContextKeyExpr.not(CONTEXT_FIND_WIDGET_VISIBLE.key);
export const CONTEXT_FIND_INPUT_FOCUSED = new RawContextKey<boolean>('findInputFocussed', false);
export const CONTEXT_REPLACE_INPUT_FOCUSED = new RawContextKey<boolean>('replaceInputFocussed', false);
export const CONTEXT_FIND_WIDGET_FOCUSED = new RawContextKey<boolean>('findWidgetFocused', false);

export const ToggleCaseSensitiveKeybinding = { primary: KeyMod.Alt | KeyCode.KeyC, mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyC } };
export const ToggleWholeWordKeybinding = { primary: KeyMod.Alt | KeyCode.KeyW, mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyW } };
export const ToggleRegexKeybinding = { primary: KeyMod.Alt | KeyCode.KeyR, mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR } };
export const ToggleSearchScopeKeybinding = { primary: KeyMod.Alt | KeyCode.KeyL, mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyL } };
export const TogglePreserveCaseKeybinding = { primary: KeyMod.Alt | KeyCode.KeyP, mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyP } };

export const FIND_IDS = {
	StartFindAction: 'actions.find',
	StartFindWithSelection: 'actions.findWithSelection',
	StartFindWithArgs: 'editor.actions.findWithArgs',
	NextMatchFindAction: 'editor.action.nextMatchFindAction',
	PreviousMatchFindAction: 'editor.action.previousMatchFindAction',
	GoToMatchFindAction: 'editor.action.goToMatchFindAction',
	NextSelectionMatchFindAction: 'editor.action.nextSelectionMatchFindAction',
	PreviousSelectionMatchFindAction: 'editor.action.previousSelectionMatchFindAction',
	StartFindReplaceAction: 'editor.action.startFindReplaceAction',
	CloseFindWidgetCommand: 'closeFindWidget',
	ToggleCaseSensitiveCommand: 'toggleFindCaseSensitive',
	ToggleWholeWordCommand: 'toggleFindWholeWord',
	ToggleRegexCommand: 'toggleFindRegex',
	ToggleSearchScopeCommand: 'toggleFindInSelection',
	TogglePreserveCaseCommand: 'togglePreserveCase',
	ReplaceOneAction: 'editor.action.replaceOne',
	ReplaceAllAction: 'editor.action.replaceAll',
	SelectAllMatchesAction: 'editor.action.selectAllMatches',
} as const;

export const MATCHES_LIMIT = 19_999;
const REPLACE_ALL_LIMIT = 100_000;

/** Keeps search results in sync with the editor model and applies find commands. */
export class FindModelBoundToEditorModel extends Disposable {
	private model: TextModel | null = null;
	private readonly decorations = this._register(new MutableDisposable<FindDecorations>());
	private matches: readonly TextSearchMatch[] = [];
	private changingModel = false;
	private searchError: TextSearchQueryError | null = null;

	constructor(private readonly editor: ICodeEditor, private readonly state: FindReplaceState) {
		super();
		this.bindModel();
		this._register(editor.onDidChangeModel(() => this.bindModel()));
		this._register(state.onFindReplaceStateChange(event => {
			if (event.isRevealed && !state.isRevealed) {
				this.matches = [];
				this.decorations.value?.reset();
				this.state.changeMatchInfo(0, 0, undefined);
			} else if (state.isRevealed && (event.isRevealed || event.searchString || event.isRegex || event.matchCase || event.wholeWord || event.searchScope)) {
				this.research(event.moveCursor);
			}
		}));
		this._register(editor.onDidChangeModelContent(() => {
			if (state.isRevealed && !this.changingModel) this.research(false);
		}));
		if (state.isRevealed) this.research(false);
	}

	public get error(): TextSearchQueryError | null { return this.searchError; }

	public moveToPrevMatch(): void { this.move(-1); }
	public moveToNextMatch(): void { this.move(1); }
	public moveToMatch(index: number): void { this.select(index); }

	public replace(): void {
		if (!this.model || !this.matches.length || this.editor.getOption(EditorOption.readOnly)) return;
		const index = this.findCurrentIndex();
		const match = this.matches[index];
		if (!match) return;
		if (!Range.equalsRange(this.editor.getSelection(), match.range)) {
			this.select(index);
			return;
		}
		this.assertCurrentMatch(match);
		this.changingModel = true;
		try {
			this.editor.pushUndoStop();
			this.editor.executeCommand(FIND_IDS.ReplaceOneAction, new ReplaceCommand(match.range, this.replacementFor(match)));
			this.editor.pushUndoStop();
		} finally {
			this.changingModel = false;
		}
		this.research(true);
	}

	public replaceAll(): void {
		if (!this.model || !this.state.searchString || this.searchError || this.editor.getOption(EditorOption.readOnly)) return;
		const matches = this.search(REPLACE_ALL_LIMIT);
		if (!matches.length) return;
		for (const match of matches) this.assertCurrentMatch(match);
		const ranges = matches.map(match => match.range);
		const replacements = matches.map(match => this.replacementFor(match));
		this.changingModel = true;
		try {
			this.editor.pushUndoStop();
			this.editor.executeCommand(FIND_IDS.ReplaceAllAction, new ReplaceAllCommand(this.selection, ranges, replacements));
			this.editor.pushUndoStop();
		} finally {
			this.changingModel = false;
		}
		this.research(false);
	}

	public selectAllMatches(): void {
		if (!this.matches.length) return;
		const matches = this.search(REPLACE_ALL_LIMIT);
		this.editor.setSelections(matches.map(match => Selection.fromPositions(match.range.getStartPosition(), match.range.getEndPosition())), 'find');
	}

	private bindModel(): void {
		// The query belongs to the editor; match ranges and selection scopes belong to its current model.
		this.decorations.clear();
		this.model = this.editor.getModel() as TextModel | null;
		if (this.model) this.decorations.value = new FindDecorations(this.editor);
		this.matches = [];
		this.searchError = null;
		if (this.state.searchScope !== null) this.state.change({ searchScope: null }, false);
		else if (this.state.isRevealed) this.research(false);
		else this.state.changeMatchInfo(0, 0, undefined);
	}

	private research(moveCursor: boolean): void {
		try {
			this.matches = this.search(MATCHES_LIMIT);
			this.searchError = null;
		} catch (error) {
			if (!(error instanceof TextSearchQueryError)) throw error;
			this.matches = [];
			this.searchError = error;
		}
		const scopes = this.state.searchScope === null ? null : this.decorations.value?.getFindScopes() ?? this.state.searchScope;
		this.decorations.value?.set(this.matches, scopes);
		const index = this.findCurrentIndex();
		this.decorations.value?.setCurrentFindMatch(this.matches[index]?.range ?? null);
		this.state.changeMatchInfo(index + 1, this.matches.length, this.matches[index]?.range);
		if (moveCursor && index >= 0) this.select(index);
	}

	private search(limit: number): readonly TextSearchMatch[] {
		if (!this.model) return [];
		const scopes = this.state.searchScope === null ? null : this.decorations.value?.getFindScopes() ?? this.state.searchScope;
		if (!scopes?.length) return findTextMatches(this.model, this.query, { resultLimit: limit });
		const found: TextSearchMatch[] = [];
		for (const scope of scopes) {
			found.push(...findTextMatches(this.model, this.query, { range: scope, resultLimit: limit - found.length }));
			if (found.length >= limit) break;
		}
		return found;
	}

	private move(delta: -1 | 1): void {
		if (!this.matches.length) return;
		const selection = this.selection;
		const exact = this.matches.findIndex(match => Range.equalsRange(match.range, selection));
		let candidate: number;
		if (exact >= 0) {
			candidate = exact + delta;
		} else if (delta > 0) {
			candidate = this.matches.findIndex(match => Range.compareRangesUsingStarts(match.range, selection) >= 0);
			if (candidate < 0) candidate = this.matches.length;
		} else {
			candidate = -1;
			for (let index = this.matches.length - 1; index >= 0; index--) {
				if (Range.compareRangesUsingStarts(this.matches[index]!.range, selection) < 0) {
					candidate = index;
					break;
				}
			}
		}
		const index = this.state.loop ? rot(candidate, this.matches.length) : Math.max(0, Math.min(this.matches.length - 1, candidate));
		this.select(index);
	}

	private select(index: number): void {
		const match = this.matches[index];
		if (!match) return;
		this.decorations.value?.setCurrentFindMatch(match.range);
		this.state.changeMatchInfo(index + 1, this.matches.length, match.range);
		this.editor.setSelection(match.range, 'find');
		this.editor.revealRange(match.range);
	}

	private findCurrentIndex(): number {
		const model = this.model;
		if (!model || !this.matches.length) return -1;
		const selection = this.selection;
		const exact = this.matches.findIndex(match => Range.equalsRange(match.range, selection));
		if (exact >= 0) return exact;
		const offset = model.offsetAt(selection.getPosition());
		const following = this.matches.findIndex(match => model.offsetAt(match.range.getStartPosition()) >= offset);
		return following < 0 ? 0 : following;
	}

	private replacementFor(match: TextSearchMatch): string {
		const pattern = this.state.isRegex ? parseReplaceString(this.state.replaceString) : ReplacePattern.fromStaticValue(this.state.replaceString);
		const captures: string[] & { groups?: Record<string, string | undefined> } = [match.text, ...match.captures.map(value => value ?? '')];
		captures.groups = { ...match.namedCaptures };
		return pattern.buildReplaceString(captures, this.state.preserveCase);
	}

	private assertCurrentMatch(match: TextSearchMatch): void {
		if (!this.model || match.modelVersion !== this.model.version) throw new Error('Text search match belongs to a stale model version');
		if (this.model.getTextInRange(match.range) !== match.text) throw new Error('Text search match no longer identifies the same text');
	}

	private get query(): TextModelSearchQuery {
		return {
			pattern: this.state.searchString,
			patternKind: this.state.isRegex ? TextSearchPatternKind.RegularExpression : TextSearchPatternKind.Literal,
			matchCase: this.state.matchCase,
			wholeWord: this.state.wholeWord,
			wordSeparators: this.editor.getOption(EditorOption.wordSeparators),
		};
	}

	private get selection(): Selection { return this.editor.getSelection()!; }
}
