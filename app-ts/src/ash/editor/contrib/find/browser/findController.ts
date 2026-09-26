import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { localize2 } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import {
	EditorAction,
	EditorCommand,
	MultiEditorAction,
	registerEditorAction,
	registerEditorCommand,
	registerEditorContribution,
	registerMultiEditorAction,
	type ServicesAccessor,
} from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Selection } from '../../../common/core/selection.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type TrackedRange } from '../../../common/model/trackedRange.js';
import {
	FIND_IDS,
	CONTEXT_FIND_WIDGET_VISIBLE,
	CONTEXT_REPLACE_INPUT_FOCUSED,
	ToggleCaseSensitiveKeybinding,
	ToggleWholeWordKeybinding,
	ToggleRegexKeybinding,
	ToggleSearchScopeKeybinding,
	TogglePreserveCaseKeybinding,
	FindModelBoundToEditorModel,
} from './findModel.js';
import { FindReplaceState, type INewFindReplaceState } from './findState.js';
import { FindWidget } from './findWidget.js';
import { FindOptionsWidget } from './findOptionsWidget.js';
import { FindWidgetSearchHistory } from './findWidgetSearchHistory.js';
import { ReplaceWidgetHistory } from './replaceWidgetHistory.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

const SEARCH_STRING_MAX_LENGTH = 524_288;
let sharedFindTerm = '';

export function getSelectionSearchString(
	editor: ICodeEditor,
	seedSearchStringFromSelection: 'single' | 'multiple' = 'single',
	seedSearchStringFromNonEmptySelection = false,
): string | null {
	const model = editor.getModel();
	const selection = editor.getSelection();
	if (!model || !selection) return null;
	if (seedSearchStringFromSelection === 'single' && selection.startLineNumber !== selection.endLineNumber) return null;
	if (selection.isEmpty()) return seedSearchStringFromNonEmptySelection ? null : model.getWordAtPosition(selection.getStartPosition())?.word ?? null;
	return model.getValueLengthInRange(selection) < SEARCH_STRING_MAX_LENGTH ? model.getValueInRange(selection) : null;
}

export const enum FindStartFocusAction {
	NoFocusChange,
	FocusFindInput,
	FocusReplaceInput,
}

export interface IFindStartOptions {
	forceRevealReplace: boolean;
	seedSearchStringFromSelection: 'none' | 'single' | 'multiple';
	seedSearchStringFromNonEmptySelection: boolean;
	seedSearchStringFromGlobalClipboard: boolean;
	shouldFocus: FindStartFocusAction;
	shouldAnimate: boolean;
	updateSearchScope: boolean;
	loop: boolean;
}

export interface IFindStartArguments {
	searchString?: string;
	replaceString?: string;
	isRegex?: boolean;
	matchWholeWord?: boolean;
	isCaseSensitive?: boolean;
	preserveCase?: boolean;
	findInSelection?: boolean;
}

/** Coordinates find state and model-backed commands for one editor. */
export class CommonFindController extends Disposable {
	public static readonly ID = 'editor.contrib.findController';
	public static get(editor: ICodeEditor): CommonFindController | null { return editor.getContribution<CommonFindController>(CommonFindController.ID); }

	protected readonly state = this._register(new FindReplaceState());
	protected readonly model: FindModelBoundToEditorModel;
	protected widget: FindWidget | null = null;
	protected optionsWidget: FindOptionsWidget | null = null;
	protected readonly selectionScope = this._register(new MutableDisposable<TrackedRange>());
	private readonly findVisible;

	constructor(protected readonly _editor: ICodeEditor) {
		super();
		this.findVisible = _editor.invokeWithinContext(accessor => CONTEXT_FIND_WIDGET_VISIBLE.bindTo(accessor.get(IContextKeyService)));
		this.state.change({ loop: this.findOptions.loop }, false);
		this.model = this._register(new FindModelBoundToEditorModel(_editor, this.state));
		this._register(_editor.onDidChangeModel(() => {
			this.selectionScope.clear();
			this.widget?.updateSearchScopeAvailability();
		}));
		this._register(this.state.onFindReplaceStateChange(event => {
			if (event.isRevealed) this.findVisible.set(this.state.isRevealed);
		}));
	}

	public get editor(): ICodeEditor { return this._editor; }
	public getState(): FindReplaceState { return this.state; }
	public isFindInputFocused(): boolean { return this.widget?.isFindInputFocused() ?? false; }
	public wasReplaceInputLastFocused(): boolean { return this.widget?.lastFocusedInputWasReplace ?? false; }
	public focusLastElement(): void { this.widget?.focusLastElement(); }

	public closeFindWidget(): void {
		if (!this.state.isRevealed) return;
		this.state.change({ isRevealed: false, searchScope: null }, false);
		this.selectionScope.clear();
		this._editor.focus();
	}

	public toggleCaseSensitive(): void { this.state.change({ matchCase: !this.state.matchCase }, true); }
	public toggleWholeWords(): void { this.state.change({ wholeWord: !this.state.wholeWord }, true); }
	public toggleRegex(): void { this.state.change({ isRegex: !this.state.isRegex }, true); }
	public togglePreserveCase(): void { this.state.change({ preserveCase: !this.state.preserveCase }, false); }
	public toggleSearchScope(): void {
		if (this.state.searchScope === null && !this.selectionScope.value) this.captureSelectionScope();
		const range = this.selectionScope.value?.range;
		this.state.change({ searchScope: this.state.searchScope === null && range && !range.isEmpty() ? [range] : null }, true);
		this.widget?.updateSearchScopeAvailability();
	}

	public setSearchString(searchString: string): void { this.state.change({ searchString }, true); }
	public highlightFindOptions(ignoreWhenVisible = false): void {
		if (this.state.isRevealed) {
			if (!ignoreWhenVisible) this.widget?.highlightFindOptions();
		} else this.optionsWidget?.highlightFindOptions();
	}

	public start(options: IFindStartOptions, newState: INewFindReplaceState = {}): Promise<void> { return this._start(options, newState); }

	protected async _start(options: IFindStartOptions, newState: INewFindReplaceState = {}): Promise<void> {
		if (!this._editor.hasModel()) return;
		const wasVisible = this.state.isRevealed;
		if (!wasVisible && options.updateSearchScope) this.captureSelectionScope();
		const selectedText = wasVisible || options.seedSearchStringFromSelection === 'none' ? null
			: getSelectionSearchString(this._editor, options.seedSearchStringFromSelection, options.seedSearchStringFromNonEmptySelection);
		const seededText = selectedText && (newState.isRegex ?? this.state.isRegex)
			? escapeRegExpCharacters(selectedText) : selectedText;
		const searchString = newState.searchString ?? seededText ?? (
			options.seedSearchStringFromGlobalClipboard && !this.state.searchString ? sharedFindTerm : this.state.searchString
		);
		const selection = this.selection;
		const autoFindInSelection = this.findOptions.autoFindInSelection;
		const useScope = options.updateSearchScope && !wasVisible && (
			autoFindInSelection === 'always' ||
			autoFindInSelection === 'multiline' && selection.startLineNumber !== selection.endLineNumber
		);
		const range = this.selectionScope.value?.range;
		this.state.change({
			...newState,
			searchString,
			isRevealed: true,
			isReplaceRevealed: !this._editor.getOption(EditorOption.readOnly) &&
				(options.forceRevealReplace || this.state.isReplaceRevealed),
			loop: options.loop,
			...(useScope && range && !range.isEmpty() ? { searchScope: [range] } : {}),
		}, false);
	}

	public moveToNextMatch(): boolean {
		if (!this.state.matchesCount) return false;
		this.model.moveToNextMatch();
		return true;
	}
	public moveToPrevMatch(): boolean {
		if (!this.state.matchesCount) return false;
		this.model.moveToPrevMatch();
		return true;
	}
	public goToMatch(index: number): boolean {
		if (index < 0 || index >= this.state.matchesCount) return false;
		this.model.moveToMatch(index);
		return true;
	}
	public replace(): boolean {
		this.widget?.recordReplaceHistory();
		if (!this.state.matchesCount || this._editor.getOption(EditorOption.readOnly)) return false;
		this.model.replace();
		return true;
	}
	public replaceAll(): boolean {
		if (!this.state.matchesCount || this._editor.getOption(EditorOption.readOnly)) return false;
		this.model.replaceAll();
		return true;
	}
	public selectAllMatches(): boolean {
		if (!this.state.matchesCount) return false;
		this.model.selectAllMatches();
		this._editor.focus();
		return true;
	}
	public async getGlobalBufferTerm(): Promise<string> { return sharedFindTerm; }
	public setGlobalBufferTerm(text: string): void { sharedFindTerm = text; }

	protected get hasSelectionScope(): boolean { return this.selectionScope.value?.range.isEmpty() === false; }
	private captureSelectionScope(): void {
		const selection = this.selection;
		// Match navigation changes the editor selection, so keep the opening range tracked by the model.
		this.selectionScope.value = selection.isEmpty() ? undefined
			: (this._editor.getModel() as TextModel).trackRange(selection, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
		this.widget?.updateSearchScopeAvailability();
	}
	private get findOptions() { return this._editor.getOption(EditorOption.find); }
	private get selection(): Selection { return this._editor.getSelection()!; }
}

/** Adds the find widget and keyboard behavior to the shared controller. */
export class FindController extends CommonFindController {
	constructor(editor: ICodeEditor, storageService: IStorageService | undefined, keybindingService: IKeybindingService, hoverService: IHoverService) {
		super(editor);
		const findOptions = editor.getOption(EditorOption.find);
		this.widget = this._register(new FindWidget(editor, {
			replace: () => this.replace(),
			replaceAll: () => this.replaceAll(),
			getGlobalBufferTerm: () => this.getGlobalBufferTerm(),
			moveToNextMatch: () => this.moveToNextMatch(),
			moveToPrevMatch: () => this.moveToPrevMatch(),
			closeFindWidget: () => this.closeFindWidget(),
			toggleSearchScope: () => this.toggleSearchScope(),
			isSearchScopeAvailable: () => this.hasSelectionScope,
		}, this.state, this.model, hoverService, keybindingService,
			storageService && findOptions.history !== 'never' ? FindWidgetSearchHistory.getOrCreate(storageService) : undefined,
			storageService && findOptions.replaceHistory !== 'never' ? ReplaceWidgetHistory.getOrCreate(storageService) : undefined));
		this.optionsWidget = this._register(new FindOptionsWidget(editor, this.state, keybindingService, hoverService));
	}

	protected override _start(options: IFindStartOptions, newState: INewFindReplaceState = {}): Promise<void> {
		const completion = super._start(options, newState);
		if (options.shouldFocus === FindStartFocusAction.FocusReplaceInput) this.widget?.focusReplaceInput();
		else if (options.shouldFocus === FindStartFocusAction.FocusFindInput) this.widget?.focusFindInput();
		return completion;
	}

	public saveViewState(): unknown {
		return {
			searchString: this.state.searchString,
			replaceString: this.state.replaceString,
			isReplaceRevealed: this.state.isReplaceRevealed,
			widget: this.widget?.getViewState(),
		};
	}
	public restoreViewState(value: unknown): void {
		if (!value || typeof value !== 'object') return;
		const state = value as {
			searchString?: string;
			replaceString?: string;
			isReplaceRevealed?: boolean;
			widget?: { widgetViewZoneVisible: boolean; scrollTop: number };
		};
		this.state.change({ searchString: state.searchString, replaceString: state.replaceString, isReplaceRevealed: state.isReplaceRevealed }, false);
		this.widget?.setViewState(state.widget);
	}
}

function defaultStartOptions(editor: ICodeEditor, replace: boolean, focus: FindStartFocusAction): IFindStartOptions {
	const find = editor.getOption(EditorOption.find);
	return {
		forceRevealReplace: replace,
		seedSearchStringFromSelection: find.seedSearchStringFromSelection === 'never' ? 'none' : find.seedSearchStringFromSelection === 'always' ? 'multiple' : 'single',
		seedSearchStringFromNonEmptySelection: false,
		seedSearchStringFromGlobalClipboard: false,
		shouldFocus: focus,
		shouldAnimate: true,
		updateSearchScope: true,
		loop: find.loop,
	};
}

registerEditorContribution({
	id: CommonFindController.ID,
	install: context => {
		if (context.kind !== 'text') return;
		const storageService = context.instantiationService.invokeFunction(accessor => accessor.getOptional(IStorageService));
		const keybindingService = context.instantiationService.invokeFunction(accessor => accessor.get(IKeybindingService));
		const hoverService = context.instantiationService.invokeFunction(accessor => accessor.get(IHoverService));
		return new FindController(context.editor, storageService, keybindingService, hoverService);
	},
});

export const StartFindAction = registerMultiEditorAction(new MultiEditorAction({
	id: FIND_IDS.StartFindAction,
	label: localize2('find', 'Find'),
	precondition: undefined,
	kbOpts: { primary: KeyMod.CtrlCmd | KeyCode.KeyF, weight: KeybindingWeight.EditorContrib, kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true) },
}));
StartFindAction.addImplementation(0, (_accessor, editor) => {
	const controller = CommonFindController.get(editor);
	return controller ? controller.start(defaultStartOptions(editor, false, FindStartFocusAction.FocusFindInput)) : false;
});

export const StartFindReplaceAction = registerMultiEditorAction(new MultiEditorAction({
	id: FIND_IDS.StartFindReplaceAction,
	label: localize2('replace', 'Replace'),
	precondition: EditorContextKeys.writable,
	kbOpts: {
		primary: KeyMod.CtrlCmd | KeyCode.KeyH,
		mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyF },
		weight: KeybindingWeight.EditorContrib,
		kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
	},
}));
StartFindReplaceAction.addImplementation(0, (_accessor, editor) => {
	const controller = CommonFindController.get(editor);
	return controller ? controller.start(defaultStartOptions(editor, true, FindStartFocusAction.FocusFindInput)) : false;
});

export class StartFindWithArgsAction extends EditorAction {
	constructor() {
		super({ id: FIND_IDS.StartFindWithArgs, label: localize2('findWithArgs', 'Find with Arguments'), precondition: undefined });
	}
	public run(_accessor: ServicesAccessor, editor: ICodeEditor, input: unknown): Promise<void> | void {
		const controller = CommonFindController.get(editor);
		if (!controller) return;
		const args = (input ?? {}) as IFindStartArguments;
		const options = defaultStartOptions(editor, args.replaceString !== undefined, FindStartFocusAction.FocusFindInput);
		return controller.start(options, {
			searchString: args.searchString,
			replaceString: args.replaceString,
			isRegex: args.isRegex,
			wholeWord: args.matchWholeWord,
			matchCase: args.isCaseSensitive,
			preserveCase: args.preserveCase,
		}).then(() => {
			if (args.findInSelection && controller.getState().searchScope === null) controller.toggleSearchScope();
			controller.setGlobalBufferTerm(controller.getState().searchString);
		});
	}
}

export class StartFindWithSelectionAction extends EditorAction {
	constructor() {
		super({ id: FIND_IDS.StartFindWithSelection, label: localize2('findWithSelection', 'Find with Selection'), precondition: undefined });
	}
	public run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> | void {
		const controller = CommonFindController.get(editor);
		if (!controller) return;
		const searchString = getSelectionSearchString(editor, 'multiple');
		const query = searchString && controller.getState().isRegex ? escapeRegExpCharacters(searchString) : searchString;
		return controller.start(defaultStartOptions(editor, false, FindStartFocusAction.FocusFindInput), query === null ? {} : { searchString: query }).then(() => {
			controller.setGlobalBufferTerm(controller.getState().searchString);
		});
	}
}

export abstract class MatchFindAction extends EditorAction {
	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		const controller = CommonFindController.get(editor);
		if (!controller) return;
		if (!this._run(controller)) {
			await controller.start(defaultStartOptions(editor, false, FindStartFocusAction.NoFocusChange));
			this._run(controller);
		}
	}
	protected abstract _run(controller: CommonFindController): boolean;
}

async function navigateFind(editor: ICodeEditor, next: boolean): Promise<void> {
	const controller = CommonFindController.get(editor);
	if (!controller) return;
	const wasVisible = controller.getState().isRevealed;
	if (!controller.getState().matchesCount) await controller.start(defaultStartOptions(editor, false, FindStartFocusAction.NoFocusChange));
	const before = editor.getSelection();
	const moved = next ? controller.moveToNextMatch() : controller.moveToPrevMatch();
	const after = editor.getSelection();
	if (moved && after && (!before || !before.equalsSelection(after))) {
		editor.pushUndoStop();
		if (wasVisible && editor.getOption(EditorOption.find).closeOnResult && controller.isFindInputFocused()) controller.closeFindWidget();
	}
}

export const NextMatchFindAction = registerMultiEditorAction(new MultiEditorAction({
	id: FIND_IDS.NextMatchFindAction,
	label: localize2('findNextMatch', 'Find Next'),
	precondition: undefined,
	kbOpts: { primary: KeyCode.F3, weight: KeybindingWeight.EditorContrib, kbExpr: EditorContextKeys.focus.isEqualTo(true) },
}));
NextMatchFindAction.addImplementation(0, (_accessor, editor) => navigateFind(editor, true));

export const PreviousMatchFindAction = registerMultiEditorAction(new MultiEditorAction({
	id: FIND_IDS.PreviousMatchFindAction,
	label: localize2('findPreviousMatch', 'Find Previous'),
	precondition: undefined,
	kbOpts: { primary: KeyMod.Shift | KeyCode.F3, weight: KeybindingWeight.EditorContrib, kbExpr: EditorContextKeys.focus.isEqualTo(true) },
}));
PreviousMatchFindAction.addImplementation(0, (_accessor, editor) => navigateFind(editor, false));

export class MoveToMatchFindAction extends EditorAction {
	constructor() { super({ id: FIND_IDS.GoToMatchFindAction, label: localize2('goToFindMatch', 'Go to Match...'), precondition: CONTEXT_FIND_WIDGET_VISIBLE.isEqualTo(true) }); }
	public run(accessor: ServicesAccessor, editor: ICodeEditor, input: unknown): void {
		const controller = CommonFindController.get(editor);
		if (!controller?.getState().matchesCount) return;
		if (typeof input === 'number') { controller.goToMatch(input - 1); return; }
		const picker = accessor.get(IQuickInputService).createQuickPick();
		picker.ariaLabel = localize2('goToFindMatch', 'Go to Match...').value;
		picker.placeholder = localize2('goToFindMatchPlaceholder', 'Enter a match number').value;
		picker.items = [];
		picker.onDidChangeValue(value => {
			const number = Number(value);
			picker.items = Number.isInteger(number) && number >= 1 && number <= controller.getState().matchesCount ? [{ label: value }] : [];
		});
		picker.onDidAccept(item => { controller.goToMatch(Number(item.label) - 1); picker.hide(); });
		picker.onDidHide(() => picker.dispose());
		picker.show();
	}
}

export abstract class SelectionMatchFindAction extends EditorAction {
	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		const controller = CommonFindController.get(editor);
		if (!controller) return;
		const selected = getSelectionSearchString(editor);
		if (selected) controller.setSearchString(selected);
		if (!this._run(controller)) {
			await controller.start(defaultStartOptions(editor, false, FindStartFocusAction.NoFocusChange));
			this._run(controller);
		}
	}
	protected abstract _run(controller: CommonFindController): boolean;
}

export class NextSelectionMatchFindAction extends SelectionMatchFindAction {
	constructor() { super({ id: FIND_IDS.NextSelectionMatchFindAction, label: localize2('findNextSelection', 'Find Next Selection'), precondition: undefined,
		kbOpts: { primary: KeyMod.CtrlCmd | KeyCode.F3, weight: KeybindingWeight.EditorContrib, kbExpr: EditorContextKeys.focus.isEqualTo(true) } }); }
	protected _run(controller: CommonFindController): boolean { return controller.moveToNextMatch(); }
}

export class PreviousSelectionMatchFindAction extends SelectionMatchFindAction {
	constructor() { super({ id: FIND_IDS.PreviousSelectionMatchFindAction, label: localize2('findPreviousSelection', 'Find Previous Selection'), precondition: undefined,
		kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F3, weight: KeybindingWeight.EditorContrib, kbExpr: EditorContextKeys.focus.isEqualTo(true) } }); }
	protected _run(controller: CommonFindController): boolean { return controller.moveToPrevMatch(); }
}

registerEditorAction(StartFindWithArgsAction);
registerEditorAction(StartFindWithSelectionAction);
registerEditorAction(MoveToMatchFindAction);
registerEditorAction(NextSelectionMatchFindAction);
registerEditorAction(PreviousSelectionMatchFindAction);

const FindCommand = EditorCommand.bindToContribution<CommonFindController>(CommonFindController.get);
const widgetFocused = EditorContextKeys.focus.isEqualTo(true);
const widgetVisible = CONTEXT_FIND_WIDGET_VISIBLE.isEqualTo(true);
registerEditorCommand(new FindCommand({
	id: FIND_IDS.CloseFindWidgetCommand, precondition: widgetVisible, handler: controller => controller.closeFindWidget(),
	kbOpts: { primary: KeyCode.Escape, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.ToggleCaseSensitiveCommand, precondition: undefined, handler: controller => controller.toggleCaseSensitive(),
	kbOpts: { ...ToggleCaseSensitiveKeybinding, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.ToggleWholeWordCommand, precondition: undefined, handler: controller => controller.toggleWholeWords(),
	kbOpts: { ...ToggleWholeWordKeybinding, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.ToggleRegexCommand, precondition: undefined, handler: controller => controller.toggleRegex(),
	kbOpts: { ...ToggleRegexKeybinding, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.ToggleSearchScopeCommand, precondition: undefined, handler: controller => controller.toggleSearchScope(),
	kbOpts: { ...ToggleSearchScopeKeybinding, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.TogglePreserveCaseCommand, precondition: undefined, handler: controller => controller.togglePreserveCase(),
	kbOpts: { ...TogglePreserveCaseKeybinding, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.ReplaceOneAction, precondition: widgetVisible, handler: controller => controller.replace(),
	kbOpts: [
		{ primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Digit1, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
		{ primary: KeyCode.Enter, weight: KeybindingWeight.EditorContrib + 5, kbExpr: ContextKeyExpr.and(widgetFocused, CONTEXT_REPLACE_INPUT_FOCUSED.isEqualTo(true)) },
	],
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.ReplaceAllAction, precondition: widgetVisible, handler: controller => controller.replaceAll(),
	kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
registerEditorCommand(new FindCommand({
	id: FIND_IDS.SelectAllMatchesAction, precondition: widgetVisible, handler: controller => controller.selectAllMatches(),
	kbOpts: { primary: KeyMod.Alt | KeyCode.Enter, weight: KeybindingWeight.EditorContrib + 5, kbExpr: widgetFocused },
}));
