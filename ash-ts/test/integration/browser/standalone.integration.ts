import { ILanguageFeatureDebounceService } from '../../../src/ash/editor/common/services/languageFeatureDebounce.js';
import { IInlineCompletionsService } from '../../../src/ash/editor/browser/services/inlineCompletionsService.js';
import { CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextKeyService } from "../../../src/ash/platform/contextkey/browser/contextKeyService.js";
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { observableCodeEditor } from '../../../src/ash/editor/browser/observableCodeEditor.js';
import { FindController } from '../../../src/ash/editor/contrib/find/browser/findController.js';
import { StickyScrollController } from '../../../src/ash/editor/contrib/stickyScroll/browser/stickyScrollController.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { CutAction, PasteAction } from '../../../src/ash/editor/contrib/clipboard/browser/clipboard.js';
import { FontStyle, MetadataConsts } from '../../../src/ash/editor/common/encodedTokenAttributes.js';
import { SparseMultilineTokens } from '../../../src/ash/editor/common/tokens/sparseMultilineTokens.js';
import { CopyPasteController } from '../../../src/ash/editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { formatEditor, FormattingConflicts, FormattingKind, FormattingMode } from '../../../src/ash/editor/contrib/format/browser/format.js';
import { type CancellationToken } from '../../../src/ash/base/common/cancellation.js';
import { scheduleAtNextAnimationFrame } from '../../../src/ash/base/browser/scheduler.js';
import { h } from '../../../src/ash/base/browser/dom.js';
import { type Range } from '../../../src/ash/editor/common/core/range.js';
import { type IEditorOptions } from '../../../src/ash/editor/common/config/editorOptions.js';
import { EndOfLineSequence, type ITextModel } from '../../../src/ash/editor/common/model.js';
import { IVersionedEditorWorkerClient } from '../../../src/ash/editor/browser/services/editorWorkerService.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IMarkerService, MarkerSeverity } from '../../../src/ash/platform/markers/common/markers.js';
import { Color } from '../../../src/ash/base/common/color.js';
import { type LanguageFeatureRequest, TokenizationRegistry } from '../../../src/ash/editor/common/languages.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import { EditorOption } from '../../../src/ash/editor/common/config/editorOptions.js';
import { ScrollType } from '../../../src/ash/editor/common/editorCommon.js';
import { EditorExtensionsRegistry } from '../../../src/ash/editor/browser/editorExtensions.js';

interface EditorState {
	readonly value: string | null;
	readonly disposed: boolean;
	readonly registered: boolean;
	readonly modelRegistered: boolean;
	readonly mounted: boolean;
	readonly placeholder: boolean;
	readonly theme: string | null;
}

interface CreationEvent {
	readonly model: string;
	readonly registered: boolean;
	readonly mounted: boolean;
	readonly placeholder: boolean;
	readonly theme: string | null;
}

interface UndoState {
	readonly value: string;
	readonly version: number;
	readonly callerSelections: readonly string[];
	readonly ownedSelections: readonly string[];
	readonly callerFocused: boolean;
	readonly ownedFocused: boolean;
	readonly activeInput: 'caller' | 'owned' | 'other';
}

interface LineIdentityState {
	readonly value: string;
	readonly version: number;
	readonly ids: readonly string[];
	readonly longLineIndex: number;
	readonly longLineEnd: readonly [number, number];
}

interface KeyboardEditingState {
	readonly value: string;
	readonly version: number;
	readonly selection: string | null;
	readonly focused: boolean;
}

interface WrappedLayoutState {
	readonly value: string;
	readonly version: number;
	readonly modelLineCount: number;
	readonly contentHeight: number;
}

interface ViewZoneState {
	readonly version: number;
	readonly lineTop: number;
	readonly contentHeight: number;
	readonly computedHeights: readonly number[];
}

interface InlineRequestState {
	requests: { kind: string; text: string; languageId: string; aborted: boolean }[];
	delay: number;
	shared: boolean;
}

type CodeActionOutcome = 'edit' | 'disabled' | 'stale' | 'error';
interface CodeActionRequestState {
	phase: 'query' | 'resolve';
	languageId: string;
	version: number;
	range: string;
	original: boolean;
	sameContext: boolean;
	aborted: boolean;
}

type RenameOutcome = 'edit' | 'empty' | 'stale' | 'error';
interface RenameRequestState {
	phase: 'prepare' | 'edit';
	languageId: string;
	version: number;
	position: string;
	newName: string | undefined;
	sameSnapshot: boolean;
	aborted: boolean;
}

interface ParameterHintRequestState {
	text: string;
	languageId: string;
	position: string;
	context: stanza.LanguageParameterHintsContext;
	aborted: boolean;
}

type LanguageRequestKind = 'hover' | 'selection' | 'definition' | 'call' | 'type' | 'symbols';
type LanguageRequestChange = 'text' | 'selection' | 'language' | 'provider' | 'model' | 'dispose' | 'blur';
type ContributionRequestKind = 'colors' | 'highlights' | 'completion' | 'folding' | 'links' | 'codelens' | 'hover';
interface StandaloneHarness {
	updateContributionOptions(options: IEditorOptions): void;
	readContributionDecorations(): { colors: number; highlights: number; folding: number };
	prepareStickyHeaders(): void;
	prepareStickySymbols(): void;
	runStickyCommand(id: string): Promise<void>;
	scrollSticky(top: number, left?: number): void;
	hideStickyLines(start: number, end: number): void;
	readStickyState(): { starts: number[]; ends: number[]; offset: number; focused: boolean; line: number; scrollLeft: number };
	setStickyTheme(name: string): void;
	layoutContribution(width: number): void;
	prepareCompletionGeometry(scrolled: boolean): void;
	readCompletionGeometry(): { caret: { left: number; top: number; height: number }; api: { left: number; top: number; height: number }; widget: { left: number; top: number }; contentLeft: number; textLeft: number };
	prepareContributionRequests(kind: ContributionRequestKind): void;
	readContributionRequests(): { languageId: string; aborted: boolean }[];
	finishContributionRequest(index: number, empty?: boolean): Promise<void>;
	changeContributionState(reason: 'language' | 'edit' | 'dispose' | 'provider' | 'off' | 'on' | 'selection' | 'blur' | 'readonly'): void;
	contributionPoint(column: number): { x: number; y: number };
	readSelectionHighlights(): number;
	prepareColorPicker(): void;
	invokeLanguageAction(id: string): void;
	readLanguageActions(): { rename: boolean; quickFix: boolean };
	prepareLanguageRequest(kind: LanguageRequestKind): void;
	languageHoverPoint(): { x: number; y: number };
	readLanguageRequests(): { languageId: string; aborted: boolean }[];
	finishLanguageRequest(index: number): Promise<void>;
	changeLanguageRequest(reason: LanguageRequestChange): void;
	prepareParameterHints(enabled?: boolean, cycle?: boolean, triggers?: readonly string[], retriggers?: readonly string[]): void;
	readParameterHintRequests(): ParameterHintRequestState[];
	finishParameterHintRequest(index: number, outcome: 'hints' | 'empty' | 'error', hints?: stanza.LanguageParameterHints): Promise<void>;
	runParameterHintCommand(id: string, global?: boolean): Promise<void>;
	readParameterHintContext(): { supported: boolean; visible: boolean | undefined; multiple: boolean | undefined };
	changeParameterHintsState(reason: 'text' | 'selection' | 'language' | 'provider' | 'off' | 'on' | 'model' | 'contribution' | 'dispose' | 'blur'): void;
	queueParameterHints(reason: 'escape' | 'selection' | 'off' | 'blur' | 'dispose' | 'type'): void;
	shareParameterHintsModel(): void;
	prepareRenameRequests(phase: 'prepare' | 'edit'): void;
	readRenameRequests(): RenameRequestState[];
	finishRenameRequest(index: number, outcome: RenameOutcome): Promise<void>;
	changeRenameState(reason: 'text' | 'selection' | 'language' | 'provider' | 'readonly' | 'model' | 'contribution' | 'dispose' | 'blur'): void;
	prepareCodeActionRequests(phase: 'query' | 'resolve'): void;
	readCodeActionRequests(): CodeActionRequestState[];
	finishCodeActionRequest(index: number, outcome: CodeActionOutcome): Promise<void>;
	changeCodeActionState(reason: 'text' | 'selection' | 'language' | 'provider' | 'readonly' | 'model' | 'contribution' | 'dispose'): void;
	prepareInlayRequests(): void;
	readInlayRequests(): { text: string; languageId: string; resource: string | undefined; range: string; aborted: boolean }[];
	finishInlayRequest(index: number, label: string): Promise<void>;
	changeInlayState(reason: 'text' | 'shrink' | 'language' | 'provider' | 'off' | 'on' | 'contribution' | 'model' | 'dispose' | 'layout'): void;
	addBrokenInlayProvider(): void;
	prepareBracketCompletion(value: string, insertText: string, column: number, tokenType: 'other' | 'string' | 'comment' | 'unavailable', completeBracketPairs: boolean, replaceLength?: number): void;
	prepareInlineRequests(): void;
	readInlineRequests(): InlineRequestState;
	finishInlineRequest(index: number): Promise<void>;
	cancelInlineRequests(reason: 'position' | 'provider' | 'snooze' | 'dispose' | 'model' | 'blur' | 'language'): void;
	prepareLinks(): void;
	readOpenedLinks(): string[];
	setSemanticProvider(tokenType: string | null): void;
	prepareLanguageWorkers(): void;
	readLanguageWorkers(): { tokens: string[]; diagnostics: string[]; current: boolean };

	runSharedInlineSnooze(): Promise<{ shared: boolean; visibleBefore: number; visibleAfter: number; callsWhilePaused: number; pausedAfterDispose: boolean; resumed: boolean }>;
	runEmptyWordPattern(): { word: string; startColumn: number; endColumn: number } | null;
	runDisposedLanguageRequest(kind: 'codeAction' | 'rename' | 'parameterHints' | 'queuedParameterHints'): Promise<{ calls: number; aborted: boolean }>;
	runEditorActivity(): Promise<boolean[]>;
	runHistoryCommands(useAlias: boolean): Promise<string[]>;
	prepareInputHistory(): void;
	runInputHistoryCommand(command: 'undo' | 'redo' | 'default:undo' | 'default:redo'): Promise<string[]>;
	runSelectAllCommand(): Promise<{ selections: string[]; inputSelection: string }>;
	runFocusRouting(): Promise<{
		states: { stage: string; text: boolean; widget: boolean; observedText: boolean; observedWidget: boolean; contextText: boolean; contextWidget: boolean; widgetEvents: string }[];
		events: string[];
		activeAfterBlur: boolean;
		values: string[];
		activeAfterDispose: boolean;
	}>;

	runFormatterChoice(outcome: 'second' | 'empty' | 'decline' | 'error' | 'cancel' | 'silent' | 'languageChoice' | 'languageResult'): Promise<{ value: string; calls: string[]; modes: number[]; errors: string[] }>;

	runOverlappingFormatting(cancel: boolean): Promise<{ value: string; ranges: string[]; cancelled: boolean }>;

	runSelectionFormatting(mode: 'ranges' | 'single' | 'empty' | 'cancel' | 'readonly'): Promise<{ value: string; ranges: string[]; cancelled: boolean }>;

	prepareDeferredFormatting(): void;
	readDeferredFormatting(): { aborted: boolean[]; value: string };
	finishDeferredFormatting(): void;
	readEOL(): string;
	runFormatting(change: 'none' | 'position' | 'model' | 'readonly' | 'eol' | 'returnPosition' | 'range'): Promise<string>;
	runUnicodeFormatting(original: string, formatted: string): Promise<string>;

	prepareLineComment(options?: { insertSpace?: boolean; ignoreEmptyLines?: boolean; readOnly?: boolean; languageId?: string; value?: string }): void;
	prepareLineCopy(emptyTail?: boolean): void;
	prepareBrackets(value: string, columns: (number | [number, number])[], readOnly?: boolean): void;
	configureBracketColors(enabled: boolean, independent: boolean): void;
	setBracketTheme(scheme: keyof typeof stanza.ColorScheme, colors?: readonly string[]): void;
	prepareGuides(value: string): void;
	configureGuides(options: IEditorOptions): void;
	setGuideTheme(scheme: keyof typeof stanza.ColorScheme, colors?: Record<string, string>): void;
	prepareBracketToken(): void;
	prepareLineJoin(): void;
	prepareMulticursor(): void;
	runDeferredRichCopy(fail: boolean): Promise<{ pendingHtml: string; finishedHtml: string; rejected: boolean; writtenText: string }>;
	runDeferredClipboard(command: 'cut' | 'paste', change: 'none' | 'selection' | 'focus' | 'readonly' | 'composition' | 'escape' | 'model' | 'dispose', fromOutside: boolean): Promise<{ value: string; finishedBeforeTransfer: boolean }>;
	runActiveClipboard(command: 'copy' | 'cut' | 'paste', target: 'outside' | 'readonly' | 'find'): Promise<{ values: string[]; written: string; reads: number; focused: boolean; documentCommands: string[] }>;
	runDeferredPaste(change: 'none' | 'writableAgain' | 'selection' | 'composition' | 'escape'): Promise<{ value: string; handled: boolean; finishedBeforeDecode: boolean }>;
	runDeferredDrop(change: 'none' | 'readonly' | 'writableAgain'): Promise<{ value: string; selectionUnchanged: boolean; handled: boolean }>;
	runLineAction(id: string): Promise<void>;
	runScopedActions(): Promise<{ supported: boolean[]; values: string[]; otherValue: string; sameContext: boolean; focusRetained: boolean }>;
	readLineCopy(): { value: string; selections: string[] };
	prepareReferencePreview(): void;
	setParentFontSize(): void;
	updateRenderingOptions(enabled: boolean): number;
	setTestMarkers(enabled: boolean): void;
	setMinimapColor(color: string): void;
	readMinimapPixel(): number[];

	checkContracts(): Promise<{ wrapping: string; wrapped: boolean; animated: boolean; settled: boolean; top: number; interrupted: boolean; detached: boolean; eventTexts: string[] }>;
	readonly events: readonly CreationEvent[];
	state(kind: 'caller' | 'owned'): EditorState;
	switchOwnedToCaller(): { readonly ownedModelDisposed: boolean; readonly ownedModelRegistered: boolean; readonly rootRetained: boolean; readonly editorCount: number; readonly currentModelIsCaller: boolean };
	detachOwned(): { readonly modelIsNull: boolean; readonly value: string; readonly rootMounted: boolean; readonly inputCount: number };
	reattachOwned(): void;
	getOwnedValue(): string;
	getCallerVersion(): number;
	tryOverlappingSurrogateEdits(): { readonly rejected: boolean; readonly value: string; readonly versionUnchanged: boolean };
	applySurrogateEdit(): string;
	resetSameValue(): {
		readonly beforeVersion: number;
		readonly afterVersion: number;
		readonly alternativeVersion: number;
		readonly snapshotValue: string | null;
		readonly events: readonly { readonly version: number; readonly reason: string; readonly changes: number }[];
	};
	prepareSelectionUndo(): UndoState;
	applySelectionEdit(): UndoState;
	readSelectionUndo(): UndoState;
	enableCodeActions(): void;
	prepareLineIdentity(): LineIdentityState;
	splitLineIdentity(): LineIdentityState;
	readLineIdentity(): LineIdentityState;
	openLargeModel(): {
		readonly textUnits: number;
		readonly lineCount: number;
		readonly tooLargeForTokenization: boolean;
		readonly tooLargeForSynchronization: boolean;
		readonly attachedEditors: number;
		readonly firstChunkPrefix: string;
	};
	enableCompletionNavigation(snippet?: string): void;
	getCallerPosition(): { readonly lineNumber: number; readonly column: number } | null;
	prepareKeyboardEditing(): KeyboardEditingState;
	readKeyboardEditing(): KeyboardEditingState;
	selectRange(): KeyboardEditingState;
	configureClipboardTokens(highlighting: boolean, colorsAvailable?: boolean): void;
	prepareClipboard(value?: string, selections?: [number, number, number, number][], emptySelectionClipboard?: boolean): KeyboardEditingState;
	prepareWrappedLayout(): WrappedLayoutState;
	prepareProportionalWrap(): WrappedLayoutState;
	resizeWrappedLayout(width: number): WrappedLayoutState;
	editWrappedText(value: string): WrappedLayoutState;
	readWrappedLayout(): WrappedLayoutState;
	prepareViewZone(unit: 'pixels' | 'lines'): ViewZoneState;
	prepareFoldedViewZone(showInHiddenAreas: boolean): number;
	resizeViewZone(height: number, afterLineNumber: number): ViewZoneState;
	removeViewZone(): ViewZoneState;
	prepareVisibleRows(): { readonly lineCount: number; readonly version: number };
	scrollVisibleRows(top: number): number;
	editVisibleRow(lineIndex: number): string;
	prepareCursorGutter(): { readonly version: number; readonly modelLineCount: number };
	moveGutterCaret(lineNumber: number, column: number): void;
	shortenGutterLine(): number;
	preparePointerSelection(): void;
	readPointerSelection(): { readonly value: string; readonly version: number; readonly selection: string | null; readonly ownedSelection: string | null; readonly focused: boolean; readonly mouseUpEvents: number };
	prepareMultiCursor(): void;
	readMultiCursor(): { readonly value: string; readonly version: number; readonly selections: readonly string[]; readonly ownedSelections: readonly string[]; readonly focused: boolean };
	releaseCaller(): void;
	releaseOwned(): void;
	dispose(): void;
}

declare global {
	interface Window {
		ashStandaloneIntegration: StandaloneHarness;
	}
}

const callerContainer = document.querySelector<HTMLElement>('#caller')!;
const ownedContainer = document.querySelector<HTMLElement>('#owned')!;
const callerResource = stanza.URI.parse('inmemory://stanza/caller.txt');
const ownedResource = stanza.URI.parse('inmemory://stanza/owned.txt');
const events: CreationEvent[] = [];
const listener = stanza.editor.onDidCreateEditor(editor => {
	const model = editor.getModel();
	if (!model) throw new Error('Created standalone editor has no model');
	const container = model.uri.toString() === callerResource.toString() ? callerContainer : ownedContainer;
	events.push({
		model: model.uri.toString(),
		registered: stanza.editor.getEditors().includes(editor),
		mounted: container.contains(editor.getDomNode()),
		placeholder: editor.getContribution('editor.contrib.placeholderText') !== null,
		theme: container.getAttribute('data-color-theme'),
	});
});
const callerModel = stanza.editor.createModel('caller', 'plaintext', callerResource);
const openedLinks: string[] = [];
const callerEditor = stanza.editor.create(callerContainer, {
	model: callerModel,
	placeholder: 'Caller model',
	showSymbolIcons: !new URL(location.href).searchParams.has('symbolIconsOff'),
	onOpenLink: target => { openedLinks.push(target); },
	folding: !new URL(location.href).searchParams.has('contributionsOff'),
	colorDecorators: !new URL(location.href).searchParams.has('contributionsOff'),
	occurrencesHighlight: new URL(location.href).searchParams.has('contributionsOff') ? 'off' : 'singleFile',
	stickyScroll: { enabled: !new URL(location.href).searchParams.has('contributionsOff') },
	codeLens: !new URL(location.href).searchParams.has('codeLensOff'),
	inlayHints: { enabled: new URL(location.href).searchParams.has('inlayHintsOff') ? 'off' : 'on' },
});
const ownedEditor = stanza.editor.create(ownedContainer, {
	value: 'owned', language: 'plaintext', resource: ownedResource, placeholder: 'Owned model',
	showSymbolIcons: !new URL(location.href).searchParams.has('symbolIconsOff'),
});
callerEditor.layout({ width: callerContainer.clientWidth, height: callerContainer.clientHeight });
ownedEditor.layout({ width: ownedContainer.clientWidth, height: ownedContainer.clientHeight });
const ownedModel = ownedEditor.getModel();
if (!ownedModel) throw new Error('Owned standalone editor has no model');
let pointerMouseUpEvents = 0;
const pointerMouseUpListener = callerEditor.onMouseUp(() => { pointerMouseUpEvents += 1; });
const languageRequestProviders = new DisposableStore();
const languageRequests: { languageId: string; signal: AbortSignal; finish: () => void }[] = [];
let referenceRegistration: { dispose(): void } | undefined;
let parameterHintsRegistration: ReturnType<typeof stanza.languages.registerSignatureHelpProvider> | undefined;
const parameterHintRequests: {
	state: Omit<ParameterHintRequestState, 'aborted'>;
	signal: AbortSignal;
	finish: (outcome: 'hints' | 'empty' | 'error', hints?: stanza.LanguageParameterHints) => void;
}[] = [];
let renameRegistration: ReturnType<typeof stanza.languages.registerRenameProvider> | undefined;
const renameRequests: {
	state: Omit<RenameRequestState, 'aborted'>;
	signal: AbortSignal;
	finish: (outcome: RenameOutcome) => void;
}[] = [];
let codeActionRegistration: ReturnType<typeof stanza.languages.registerCodeActionProvider> | undefined;
const codeActionRequests: {
	state: Omit<CodeActionRequestState, 'aborted'>;
	signal: AbortSignal;
	finish: (outcome: CodeActionOutcome) => void;
}[] = [];
let inlineRegistration: ReturnType<typeof stanza.languages.registerInlineCompletionsProvider> | undefined;
const inlineBracketResources = new DisposableStore();
const inlineRequests: { kind: string; text: string; languageId: string; signal: AbortSignal; resolve: () => void }[] = [];
let inlayRegistration: ReturnType<typeof stanza.languages.registerInlayHintsProvider> | undefined;
let brokenInlayRegistration: ReturnType<typeof stanza.languages.registerInlayHintsProvider> | undefined;
const inlayRequests: {
	text: string;
	languageId: string;
	resource: string | undefined;
	range: string;
	signal: AbortSignal;
	resolve: (hints: readonly stanza.LanguageInlayHint[]) => void;
}[] = [];
let semanticRegistration: ReturnType<typeof stanza.languages.registerDocumentSemanticTokensProvider> | undefined;
let completionRegistration: ReturnType<typeof stanza.languages.registerCompletionItemProvider> | undefined;
const contributionProviders = new DisposableStore();
const contributionRequests: { languageId: string; isAborted: () => boolean; finish: (empty: boolean) => void }[] = [];

function deferContributionRequest<T>(languageId: string, isAborted: () => boolean, result: T, empty: T): Promise<T> {
	return new Promise(resolve => contributionRequests.push({ languageId, isAborted, finish: isEmpty => resolve(isEmpty ? empty : result) }));
}
let viewZone: stanza.IViewZone | undefined;
let viewZoneId = '';
const computedZoneHeights: number[] = [];
let longLineId: string | undefined;
let largeModel: ReturnType<typeof stanza.editor.createModel> | undefined;

function state(kind: 'caller' | 'owned'): EditorState {
	const editor = kind === 'caller' ? callerEditor : ownedEditor;
	const model = kind === 'caller' ? callerModel : ownedModel;
	if (!model) throw new Error('Standalone integration model is missing');
	const container = kind === 'caller' ? callerContainer : ownedContainer;
	return {
		value: model.isDisposed() ? null : model.getValue(),
		disposed: model.isDisposed(),
		registered: stanza.editor.getEditors().includes(editor),
		modelRegistered: stanza.editor.getModel(model.uri) === model,
		mounted: container.contains(editor.getDomNode()),
		placeholder: container.querySelector('.stanza-editor-placeholder-text') !== null,
		theme: container.getAttribute('data-color-theme'),
	};
}

function readSelectionUndo(): UndoState {
	const callerSelections = callerEditor.getSelections();
	const ownedSelections = ownedEditor.getSelections();
	if (!callerSelections || !ownedSelections) throw new Error('Shared editor selections are unavailable');
	const activeElement = document.activeElement;
	let activeInput: UndoState['activeInput'] = 'other';
	if (callerContainer.contains(activeElement)) activeInput = 'caller';
	else if (ownedContainer.contains(activeElement)) activeInput = 'owned';
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		callerSelections: callerSelections.map(selection => selection.toString()),
		ownedSelections: ownedSelections.map(selection => selection.toString()),
		callerFocused: callerEditor.hasTextFocus(),
		ownedFocused: ownedEditor.hasTextFocus(),
		activeInput,
	};
}

function readLineIdentity(): LineIdentityState {
	if (!(callerModel instanceof stanza.TextModel) || !longLineId) throw new Error('Line identity model is unavailable');
	const end = callerModel.textPositionAt({ lineId: longLineId, offset: 6 });
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		ids: callerModel.lineDocument.lines.values.map(line => line.id),
		longLineIndex: callerModel.getLineIndex(longLineId),
		longLineEnd: [end.lineNumber, end.column],
	};
}

function readKeyboardEditing(): KeyboardEditingState {
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		selection: callerEditor.getSelection()?.toString() ?? null,
		focused: callerEditor.hasTextFocus(),
	};
}

function readWrappedLayout(): WrappedLayoutState {
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		modelLineCount: callerModel.getLineCount(),
		contentHeight: callerEditor.getContentHeight(),
	};
}

function readViewZone(): ViewZoneState {
	return {
		version: callerModel.getVersionId(),
		lineTop: callerEditor.getTopForLineNumber(2),
		contentHeight: callerEditor.getContentHeight(),
		computedHeights: [...computedZoneHeights],
	};
}

let deferredFormatting: { token: CancellationToken; resolve: () => void }[] = [];
let formattingProvider: { dispose(): void } | undefined;
let bracketTokenRegistration: { dispose(): void } | undefined;

window.ashStandaloneIntegration = {
	updateContributionOptions: options => callerEditor.updateOptions(options),
	readContributionDecorations: () => {
		const decorations = callerModel.getAllDecorations();
		return {
			colors: decorations.filter(decoration => decoration.options.description === 'colorDetector').length,
			highlights: decorations.filter(decoration => decoration.options.description === 'word-highlight').length,
			folding: decorations.filter(decoration => decoration.options.description?.startsWith('folding-')).length,
		};
	},
	prepareStickyHeaders: () => {
		callerEditor.setValue(['function outer() {', '  function inner() {', ...Array.from({ length: 80 }, (_, index) => `    item ${index}`), '  }', '}', ...Array.from({ length: 30 }, () => 'outside')].join('\n'));
		callerEditor.setScrollTop(200);
	},
	prepareStickySymbols: () => {
		languageRequestProviders.clear();
		callerEditor.setValue(['// leading comment', 'class Outer {', '  // method comment', '  method() {', ...Array.from({ length: 80 }, () => `    ${'body '.repeat(40)}`), '  }', '}'].join('\n'));
		callerEditor.setScrollTop(200);
		languageRequestProviders.add(stanza.languages.registerDocumentSymbolProvider('*', {
			provideDocumentSymbols: request => new Promise(resolve => {
				languageRequests.push({
					languageId: request.languageId,
					signal: request.signal,
					finish: () => resolve([{
						name: 'Outer', kind: 'class', range: new stanza.Range(1, 1, 86, 2), selectionRange: new stanza.Range(2, 1, 2, 6),
						children: [{ name: 'method', kind: 'function', range: new stanza.Range(3, 1, 85, 4), selectionRange: new stanza.Range(4, 3, 4, 9) }],
					}]),
				});
			}),
		}));
	},
	runStickyCommand: async id => {
		if (!callerEditor.hasWidgetFocus()) callerEditor.focus();
		await callerEditor.invokeWithinContext(accessor => CommandsRegistry.getCommand(id)!(accessor));
	},
	scrollSticky: (top, left = 0) => callerEditor.setScrollPosition({ scrollTop: top, scrollLeft: left }),
	hideStickyLines: (start, end) => callerEditor._getViewModel()!.setHiddenAreas([new stanza.Range(start, 1, end, 1)]),
	readStickyState: () => {
		const controller = StickyScrollController.get(callerEditor)!;
		const state = controller.findScrollWidgetState();
		return {
			starts: state.startLineNumbers,
			ends: state.endLineNumbers,
			offset: state.lastLineRelativePosition,
			focused: controller.isFocused(),
			line: callerEditor.getPosition()!.lineNumber,
			scrollLeft: callerEditor.getScrollLeft(),
		};
	},
	setStickyTheme: name => stanza.editor.setTheme(name),
	layoutContribution: width => callerEditor.layout({ width, height: 180 }),
	prepareCompletionGeometry: scrolled => {
		const lineNumber = scrolled ? 40 : 1;
		callerEditor.setValue(Array.from({ length: 80 }, () => 'alpha '.repeat(50)).join('\n'));
		callerEditor.setPosition(new stanza.Position(lineNumber, scrolled ? 31 : 6));
		callerEditor.setScrollPosition({ scrollTop: scrolled ? 650 : 0, scrollLeft: scrolled ? 80 : 0 });
		callerEditor.focus();
	},
	readCompletionGeometry: () => {
		const position = callerEditor.getPosition()!;
		const row = callerContainer.querySelector<HTMLElement>(`.view-line[data-logical-line-index="${position.lineNumber - 1}"]`)!;
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		let remaining = position.column - 1;
		let text: Node | null;
		const range = document.createRange();
		while (text = walker.nextNode()) {
			if (remaining <= text.textContent!.length) {
				range.setStart(text, remaining);
				break;
			}
			remaining -= text.textContent!.length;
		}
		range.collapse(true);
		const caret = range.getBoundingClientRect();
		const root = callerEditor.getDomNode()!.getBoundingClientRect();
		const widget = callerContainer.querySelector('.stanza-editor-completion')!.getBoundingClientRect();
		return {
			caret: { left: caret.left - root.left, top: caret.top - root.top, height: caret.height },
			api: callerEditor.getScrolledVisiblePosition(position)!,
			widget: { left: widget.left - root.left, top: widget.top - root.top },
			contentLeft: callerEditor.getLayoutInfo().contentLeft,
			textLeft: observableCodeEditor(callerEditor).getLeftOfPosition(position),
		};
	},
	prepareContributionRequests: kind => {
		contributionProviders.clear();
		callerModel.setLanguage('typescript');
		callerEditor.setValue('alpha beta\n  gamma\nalpha');
		callerEditor.setPosition(new stanza.Position(1, 6));
		callerEditor.focus();
		const selector = ['typescript', 'javascript'];
		if (kind === 'completion') {
			contributionProviders.add(stanza.languages.registerCompletionItemProvider(selector, {
				id: 'standalone.contribution',
				provideCompletions: (request, signal) => deferContributionRequest<stanza.LanguageCompletionProviderResult>(request.languageId, () => signal.aborted, {
					items: [{ id: 'item', label: `completion: ${request.languageId}`, kind: stanza.languages.LanguageCompletionItemKind.Text, range: stanza.Range.fromPositions(request.position), insertText: 'result' }],
					isIncomplete: true,
				}, { items: [], isIncomplete: false }),
			}));
		} else if (kind === 'colors') {
			contributionProviders.add(stanza.languages.registerColorProvider(selector, {
				provideDocumentColors: (request, signal) => deferContributionRequest(request.languageId, () => signal.aborted, [
					{ range: new stanza.Range(1, 1, 1, 6), color: { red: 1, green: 0, blue: 0, alpha: 1 } },
					{ range: new stanza.Range(3, 1, 3, 6), color: { red: 0, green: 1, blue: 0, alpha: 1 } },
				], []),
				provideColorPresentations: () => [],
			}));
		} else if (kind === 'highlights') {
			callerEditor.updateOptions({ occurrencesHighlightDelay: 0 });
			callerEditor.setPosition(new stanza.Position(1, 1));
			contributionProviders.add(stanza.languages.registerDocumentHighlightProvider(selector, {
				provideDocumentHighlights: (model, _position, token) => deferContributionRequest(model.getLanguageId(), () => token.isCancellationRequested, [
					{ range: new stanza.Range(1, 1, 1, 6), kind: stanza.DocumentHighlightKind.Read },
					{ range: new stanza.Range(3, 1, 3, 6), kind: stanza.DocumentHighlightKind.Read },
				], []),
			}));
		} else if (kind === 'folding') {
			contributionProviders.add(stanza.languages.registerFoldingRangeProvider(selector, {
				provideFoldingRanges: (request, signal) => deferContributionRequest(request.languageId, () => signal.aborted, [{ startLineIndex: 0, endLineIndex: 2 }], []),
			}));
		} else if (kind === 'links') {
			contributionProviders.add(stanza.languages.registerLinkProvider(selector, {
				provideLinks: (request, signal) => deferContributionRequest(request.languageId, () => signal.aborted, [{ range: new stanza.Range(1, 1, 1, 6), target: `https://example.invalid/${request.languageId}` }], []),
			}));
		} else if (kind === 'codelens') {
			contributionProviders.add(stanza.languages.registerCodeLensProvider(selector, {
				provideCodeLenses: (model, token) => deferContributionRequest<stanza.CodeLensList>(model.getLanguageId(), () => token.isCancellationRequested, {
					lenses: [{ range: new stanza.Range(1, 1, 1, 6), command: { id: 'test.command', title: `lens: ${model.getLanguageId()}` } }],
				}, { lenses: [] }),
			}));
		} else {
			contributionProviders.add(stanza.languages.registerHoverProvider(selector, {
				provideHover: request => {
					if (request.position.column >= 6) {
						return undefined;
					}
					return { contents: ['alpha documentation'] };
				},
			}));
		}
	},
	readContributionRequests: () => contributionRequests.map(request => ({ languageId: request.languageId, aborted: request.isAborted() })),
	finishContributionRequest: async (index, empty = false) => {
		contributionRequests[index]!.finish(empty);
		await new Promise(resolve => setTimeout(resolve, 0));
	},
	changeContributionState: reason => {
		switch (reason) {
			case 'language': callerModel.setLanguage('javascript'); break;
			case 'edit': callerModel.applyEdits([{ range: new stanza.Range(1, 1, 1, 1), text: 'x' }]); break;
			case 'dispose': callerEditor.dispose(); break;
			case 'provider': contributionProviders.clear(); break;
			case 'off': callerEditor.updateOptions({ codeLens: false, selectionHighlight: false }); break;
			case 'on': callerEditor.updateOptions({ codeLens: true, selectionHighlight: true }); break;
			case 'selection': callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6)); break;
			case 'blur': ownedEditor.focus(); break;
			case 'readonly': callerEditor.updateOptions({ readOnly: true }); break;
		}
	},
	contributionPoint: column => {
		const position = callerEditor.getScrolledVisiblePosition(new stanza.Position(1, column))!;
		const bounds = callerEditor.getDomNode()!.getBoundingClientRect();
		return { x: bounds.left + position.left + 2, y: bounds.top + position.top + position.height / 2 };
	},
	readSelectionHighlights: () => callerModel.getAllDecorations().filter(decoration => decoration.options.className === 'selection-highlight').length,
	invokeLanguageAction: id => { callerEditor.trigger('test', id, {}); },
	readLanguageActions: () => ({
		rename: callerEditor.getAction('editor.action.rename')?.isSupported() ?? false,
		quickFix: callerEditor.getAction('editor.action.quickFix')?.isSupported() ?? false,
	}),
	prepareLanguageRequest: kind => {
		languageRequestProviders.clear();
		callerEditor.setValue('first second');
		callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
		callerEditor.focus();
		const defer = <T>(request: LanguageFeatureRequest, value: T): Promise<T> => new Promise(resolve => {
			languageRequests.push({ languageId: request.languageId, signal: request.signal, finish: () => resolve(value) });
		});
		if (kind === 'hover') {
			languageRequestProviders.add(stanza.languages.registerHoverProvider('*', {
				provideHover: request => defer(request, { contents: [`hover: ${request.languageId}`] }),
			}));
		} else if (kind === 'selection') {
			languageRequestProviders.add(stanza.languages.registerSelectionRangeProvider('*', {
				provideSelectionRanges: request => defer(request, [new stanza.Range(1, 1, 1, 13)]),
			}));
		} else if (kind === 'definition') {
			languageRequestProviders.add(stanza.languages.registerDefinitionProvider('*', {
				provideDefinition: request => defer(request, [{ resource: callerResource, range: new stanza.Range(1, 7, 1, 13) }]),
			}));
		} else if (kind === 'symbols') {
			languageRequestProviders.add(stanza.languages.registerDocumentSymbolProvider('*', {
				provideDocumentSymbols: request => defer(request, [{ name: 'second', kind: 'function', range: new stanza.Range(1, 7, 1, 13), selectionRange: new stanza.Range(1, 7, 1, 13) }]),
			}));
		} else {
			const item = { name: 'root', symbolKind: 12, resource: callerResource, range: new stanza.Range(1, 1, 1, 6), selectionRange: new stanza.Range(1, 1, 1, 6), data: { opaque: 'root' } };
			if (kind === 'call') {
				languageRequestProviders.add(stanza.languages.registerCallHierarchyProvider('*', {
					prepareCallHierarchy: request => defer(request, [item]),
					provideIncomingCalls: request => defer(request, [{ item: { ...item, name: 'caller' }, fromRanges: [item.range] }]),
					provideOutgoingCalls: request => defer(request, [{ item: { ...item, name: 'callee' }, fromRanges: [item.range] }]),
				}));
			} else {
				languageRequestProviders.add(stanza.languages.registerTypeHierarchyProvider('*', {
					prepareTypeHierarchy: request => defer(request, [item]),
					provideSupertypes: request => defer(request, [{ ...item, name: 'base' }]),
					provideSubtypes: request => defer(request, [{ ...item, name: 'derived' }]),
				}));
			}
		}
	},
	languageHoverPoint: () => {
		const bounds = callerEditor.getDomNode()!.getBoundingClientRect();
		const point = callerEditor.getScrolledVisiblePosition(new stanza.Position(1, 3))!;
		return { x: bounds.left + point.left + 2, y: bounds.top + point.top + point.height / 2 };
	},
	readLanguageRequests: () => languageRequests.map(request => ({ languageId: request.languageId, aborted: request.signal.aborted })),
	finishLanguageRequest: async index => {
		languageRequests[index]!.finish();
		await Promise.resolve();
		await Promise.resolve();
	},
	changeLanguageRequest: reason => {
		if (reason === 'text') callerEditor.setValue('changed');
		if (reason === 'selection') callerEditor.setPosition(new stanza.Position(1, 2));
		if (reason === 'language') callerModel.setLanguage('typescript');
		if (reason === 'provider') languageRequestProviders.clear();
		if (reason === 'model') callerEditor.setModel(ownedModel);
		if (reason === 'dispose') callerEditor.dispose();
		if (reason === 'blur') ownedEditor.focus();
	},
	prepareColorPicker: () => {
		callerEditor.setValue('const color = #ff000080;');
		callerModel.setLanguage('css');
		callerEditor.setPosition(new stanza.Position(1, 16));
		callerEditor.focus();
	},
	prepareParameterHints: (enabled = true, cycle = true, triggers = ['(', ','], retriggers = []) => {
		parameterHintsRegistration?.dispose();
		callerEditor.setValue('call');
		callerEditor.setPosition(new stanza.Position(1, 5));
		callerEditor.updateOptions({ parameterHints: { enabled, cycle } });
		callerEditor.focus();
		parameterHintsRegistration = stanza.languages.registerSignatureHelpProvider('*', {
			signatureHelpTriggerCharacters: triggers,
			signatureHelpRetriggerCharacters: retriggers,
			provideParameterHints: (request, signal) => new Promise((resolve, reject) => parameterHintRequests.push({
				state: {
					text: request.snapshot.getText(),
					languageId: request.languageId,
					position: request.position.toString(),
					context: request.context,
				},
				signal,
				finish: (outcome, hints) => {
					if (outcome === 'error') {
						reject(new Error('parameter hints failed'));
					} else {
						resolve(hints ?? { signatures: outcome === 'empty' ? [] : [{
							label: `call(value): ${request.languageId}`,
							parameters: [{ label: 'value' }],
							activeParameter: 0,
						}] });
					}
				},
			})),
		});
	},
	readParameterHintRequests: () => parameterHintRequests.map(request => ({ ...request.state, aborted: request.signal.aborted })),
	finishParameterHintRequest: async (index, outcome, hints) => {
		parameterHintRequests[index]!.finish(outcome, hints);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	},
	runParameterHintCommand: async (id, global = false) => {
		if (global) {
			const command = CommandsRegistry.getCommand(id);
			if (!command) throw new Error(`Missing parameter hint command: ${id}`);
			await StandaloneServices.get().instantiationService.invokeFunction(accessor => command(accessor));
		} else {
			callerEditor.trigger('test', id, {});
		}
	},
	readParameterHintContext: () => callerEditor.invokeWithinContext(accessor => {
		const context = accessor.get(IContextKeyService);
		return {
			supported: callerEditor.getAction('editor.action.triggerParameterHints')?.isSupported() ?? false,
			visible: context.getValue<boolean>('parameterHintsVisible'),
			multiple: context.getValue<boolean>('parameterHintsMultipleSignatures'),
		};
	}),
	changeParameterHintsState: reason => {
		if (reason === 'text') callerEditor.setValue('changed');
		if (reason === 'selection') callerEditor.setPosition(new stanza.Position(1, 2));
		if (reason === 'language') callerModel.setLanguage('typescript');
		if (reason === 'provider') parameterHintsRegistration?.dispose();
		if (reason === 'off' || reason === 'on') callerEditor.updateOptions({ parameterHints: { enabled: reason === 'on' } });
		if (reason === 'model') callerEditor.setModel(ownedModel);
		if (reason === 'contribution') callerEditor.getContribution('editor.controller.parameterHints')!.dispose();
		if (reason === 'dispose') callerEditor.dispose();
		if (reason === 'blur') ownedEditor.focus();
	},
	queueParameterHints: reason => {
		callerEditor.trigger('keyboard', 'type', { text: '(' });
		if (reason === 'escape') {
			callerContainer.querySelector('.stanza-editor-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		} else if (reason === 'type') {
			callerEditor.trigger('keyboard', 'type', { text: 'a,' });
		} else {
			window.ashStandaloneIntegration.changeParameterHintsState(reason);
		}
	},
	shareParameterHintsModel: () => {
		ownedEditor.setModel(callerModel);
		callerEditor.focus();
	},
	prepareRenameRequests: phase => {
		renameRegistration?.dispose();
		callerEditor.setValue('value');
		callerEditor.setPosition(new stanza.Position(1, 3));
		callerEditor.focus();
		let preparation: stanza.LanguageRenameRequest;
		const wait = (requestPhase: 'prepare' | 'edit', context: stanza.LanguageRenameRequest, signal: AbortSignal): Promise<RenameOutcome> => {
			return new Promise((resolve, reject) => renameRequests.push({
				state: {
					phase: requestPhase,
					languageId: context.languageId,
					version: context.snapshot.version,
					position: context.position.toString(),
					newName: context.newName,
					sameSnapshot: context.snapshot === preparation.snapshot && context.position === preparation.position && signal === preparation.signal,
				},
				signal,
				finish: outcome => {
					if (outcome === 'error') reject(new Error('rename request failed'));
					else resolve(outcome);
				},
			}));
		};
		renameRegistration = stanza.languages.registerRenameProvider('*', {
			prepareRename: async (context, signal) => {
				preparation = context;
				if (phase === 'prepare' && await wait('prepare', context, signal) === 'empty') return undefined;
				return { range: new stanza.Range(1, 1, 1, 6), placeholder: 'value' };
			},
			provideRenameEdits: async (context, signal) => {
				const outcome = phase === 'edit' ? await wait('edit', context, signal) : 'edit';
				return { entries: outcome === 'empty' ? [] : [{
					kind: 'textDocument', resource: context.resource,
					version: context.snapshot.version + (outcome === 'stale' ? 1 : 0),
					edits: [{ range: new stanza.Range(1, 1, 1, 6), text: context.newName! }],
				}] };
			},
		});
	},
	readRenameRequests: () => renameRequests.map(request => ({ ...request.state, aborted: request.signal.aborted })),
	finishRenameRequest: async (index, outcome) => {
		renameRequests[index]!.finish(outcome);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	},
	changeRenameState: reason => {
		if (reason === 'text') callerEditor.setValue('changed');
		if (reason === 'selection') callerEditor.setPosition(new stanza.Position(1, 2));
		if (reason === 'language') callerModel.setLanguage('typescript');
		if (reason === 'provider') renameRegistration?.dispose();
		if (reason === 'readonly') callerEditor.updateOptions({ readOnly: true });
		if (reason === 'model') callerEditor.setModel(ownedModel);
		if (reason === 'contribution') callerEditor.getContribution('editor.contrib.renameController')!.dispose();
		if (reason === 'dispose') callerEditor.dispose();
		if (reason === 'blur') ownedEditor.focus();
	},
	prepareCodeActionRequests: phase => {
		codeActionRegistration?.dispose();
		callerEditor.setValue('value');
		callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
		callerEditor.focus();
		const original = { title: 'Replace value', data: { id: 1 } };
		let queryContext: stanza.LanguageCodeActionRequest;
		const wait = (
			requestPhase: 'query' | 'resolve',
			context: stanza.LanguageCodeActionRequest,
			signal: AbortSignal,
			action: stanza.LanguageCodeAction,
		): Promise<stanza.LanguageCodeAction> => {
			return new Promise((resolve, reject) => codeActionRequests.push({
				state: {
					phase: requestPhase,
					languageId: context.languageId,
					version: context.snapshot.version,
					range: context.range.toString(),
					original: action === original,
					sameContext: context === queryContext && signal === queryContext.signal,
				},
				signal,
				finish: outcome => {
					if (outcome === 'error') {
						reject(new Error('code action resolve failed'));
						return;
					}
					resolve({
						...action,
						...(outcome === 'disabled' ? { disabledReason: 'Action is unavailable' } : {}),
						edit: { entries: [{
							kind: 'textDocument', resource: context.resource,
							version: context.snapshot.version + (outcome === 'stale' ? 1 : 0),
							edits: [{ range: context.range, text: 'result' }],
						}] },
					});
				},
			}));
		};
		codeActionRegistration = stanza.languages.registerCodeActionProvider('*', {
			provideCodeActions: async (context, signal) => {
				queryContext = context;
				return phase === 'query' ? [await wait('query', context, signal, original)] : [original];
			},
			resolveCodeAction: (action, context, signal) => wait('resolve', context, signal, action),
		});
	},
	readCodeActionRequests: () => codeActionRequests.map(request => ({ ...request.state, aborted: request.signal.aborted })),
	finishCodeActionRequest: async (index, outcome) => {
		codeActionRequests[index]!.finish(outcome);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	},
	changeCodeActionState: reason => {
		if (reason === 'text') callerEditor.setValue('changed');
		if (reason === 'selection') callerEditor.setPosition(new stanza.Position(1, 2));
		if (reason === 'language') callerModel.setLanguage('typescript');
		if (reason === 'provider') codeActionRegistration?.dispose();
		if (reason === 'readonly') callerEditor.updateOptions({ readOnly: true });
		if (reason === 'model') callerEditor.setModel(ownedModel);
		if (reason === 'contribution') callerEditor.getContribution('editor.contrib.codeActionController')!.dispose();
		if (reason === 'dispose') callerEditor.dispose();
	},
	prepareInlayRequests: () => {
		inlayRegistration?.dispose();
		callerEditor.setValue('call(value)');
		callerEditor.focus();
		inlayRegistration = stanza.languages.registerInlayHintsProvider('*', {
			provideInlayHints: (request, signal) => {
				if (request.model !== callerModel) return [];
				return new Promise(resolve => inlayRequests.push({
					text: request.model.getValue(),
					languageId: request.languageId,
					resource: request.resource?.toString(),
					range: request.range.toString(),
					signal,
					resolve,
				}));
			},
		});
	},
	readInlayRequests: () => inlayRequests.map(({ resolve: _resolve, signal, ...request }) => ({ ...request, aborted: signal.aborted })),
	finishInlayRequest: async (index, label) => {
		inlayRequests[index]!.resolve([{ position: new stanza.Position(1, 6), label, tooltip: 'inlay detail' }]);
		await Promise.resolve();
		await Promise.resolve();
	},
	changeInlayState: reason => {
		if (reason === 'shrink') callerEditor.setValue('');
		if (reason === 'text') {
			callerEditor.executeEdits('test.inlay', [{ range: new stanza.Range(1, 1, 1, 1), text: 'a' }]);
			callerEditor.executeEdits('test.inlay', [{ range: new stanza.Range(1, 1, 1, 1), text: 'b' }]);
		}
		if (reason === 'language') callerModel.setLanguage('typescript');
		if (reason === 'provider') inlayRegistration?.dispose();
		if (reason === 'off' || reason === 'on') callerEditor.updateOptions({ inlayHints: { enabled: reason } });
		if (reason === 'contribution') callerEditor.getContribution('editor.contrib.inlayHints')!.dispose();
		if (reason === 'model') callerEditor.setModel(ownedModel);
		if (reason === 'dispose') callerEditor.dispose();
		if (reason === 'layout') callerEditor.layout({ width: 340, height: 220 });
	},
	addBrokenInlayProvider: () => {
		brokenInlayRegistration = stanza.languages.registerInlayHintsProvider('*', {
			provideInlayHints: () => { throw new Error('inlay provider failed'); },
		});
	},
	prepareLinks: () => {
		openedLinks.length = 0;
		callerEditor.setValue('https://example.test/path');
	},
	readOpenedLinks: () => [...openedLinks],
	setSemanticProvider: tokenType => {
		semanticRegistration?.dispose();
		semanticRegistration = undefined;
		if (tokenType === null) return;
		semanticRegistration = stanza.languages.registerDocumentSemanticTokensProvider('plaintext', {
			provideSemanticTokens: request => {
				if (request.model !== callerModel) return undefined;
				return {
					tokens: [{
						range: new stanza.Range(1, 1, 1, 7),
						tokenType,
						modifiers: ['readonly'],
					}],
				};
			},
		});
	},
	prepareLanguageWorkers: () => {
		callerModel.setLanguage('typescript');
		callerEditor.setValue('const alphabet = 1;\nconst alpha = (\nal');
		callerEditor.setPosition(new stanza.Position(3, 3));
		callerEditor.focus();
	},
	readLanguageWorkers: () => {
		if (!(callerModel instanceof stanza.TextModel)) throw new Error('Expected the standalone text model');
		return {
			tokens: callerModel.tokenization.getLanguageTokens(0).map(token => token.tokenType),
			diagnostics: callerModel.diagnostics.results.result?.value.diagnostics.map(diagnostic => diagnostic.message) ?? [],
			current: callerModel.tokenization.modelVersion === callerModel.version,
		};
	},
	prepareBracketCompletion: (value, insertText, column, tokenType, completeBracketPairs, replaceLength = 0) => {
		inlineRegistration?.dispose();
		inlineBracketResources.clear();
		callerEditor.setValue(value);
		callerModel.setLanguage('typescript');
		callerEditor.setPosition(new stanza.Position(1, column));
		if (tokenType !== 'unavailable') {
			inlineBracketResources.add(stanza.languages.registerSyntaxProvider({
				id: 'inline-bracket-test', languageIds: ['typescript'], tokenPriority: 100,
				provideTokens: () => ({ tokens: [] }),
				provideTokensForLines: request => ({ tokens: request.tokenize.lines.flatMap((line, index) => line.length ? [{
					range: new stanza.Range(index + 1, 1, index + 1, line.length + 1), tokenType, modifiers: [],
				}] : []) }),
			}));
		}
		inlineRegistration = stanza.languages.registerInlineCompletionsProvider('typescript', { provideInlineCompletions: () => [{
			insertText, completeBracketPairs, range: new stanza.Range(1, column, 1, column + replaceLength),
			additionalTextEdits: [{ range: new stanza.Range(1, 1, 1, 1), text: '/* accepted */ ' }],
		}] });
		callerEditor.focus();
	},
	prepareInlineRequests: () => {
		inlineRegistration?.dispose();
		inlineRequests.length = 0;
		callerEditor.setValue('');
		callerEditor.focus();
		inlineRegistration = stanza.languages.registerInlineCompletionsProvider('*', {
			provideInlineCompletions: async (request, signal) => {
				await new Promise<void>(resolve => inlineRequests.push({
					kind: request.triggerKind,
					text: request.model.getValue(),
					languageId: request.languageId,
					signal,
					resolve,
				}));
				return [{ insertText: ' suggestion' }];
			},
		});
	},
	readInlineRequests: () => {
		const service = StandaloneServices.get().instantiationService.get(ILanguageFeatureDebounceService);
		const other = ownedEditor.invokeWithinContext(accessor => accessor.get(ILanguageFeatureDebounceService));
		const features = StandaloneServices.get().instantiationService.get(ILanguageFeaturesService);
		return {
			requests: inlineRequests.map(request => ({ kind: request.kind, text: request.text, languageId: request.languageId, aborted: request.signal.aborted })),
			delay: service.for(features.inlineCompletionsProvider, 'Inline completions', { min: 50, max: 500 }).get(callerModel),
			shared: service === other,
		};
	},
	finishInlineRequest: async index => {
		inlineRequests[index]!.resolve();
		await Promise.resolve();
		await Promise.resolve();
	},
	cancelInlineRequests: reason => {
		if (reason === 'position') callerEditor.setPosition(new stanza.Position(1, 1));
		if (reason === 'provider') inlineRegistration?.dispose();
		if (reason === 'snooze') callerEditor.invokeWithinContext(accessor => accessor.get(IInlineCompletionsService)).snooze(10_000);
		if (reason === 'blur') ownedEditor.focus();
		if (reason === 'language') callerModel.setLanguage('typescript');
		if (reason === 'dispose') callerEditor.dispose();
		if (reason === 'model') callerEditor.setModel(ownedEditor.getModel());
	},
	runSharedInlineSnooze: async () => {
		const service = callerEditor.invokeWithinContext(accessor => accessor.get(IInlineCompletionsService));
		const other = ownedEditor.invokeWithinContext(accessor => accessor.get(IInlineCompletionsService));
		let calls = 0;
		using provider = stanza.languages.registerInlineCompletionsProvider('*', {
			provideInlineCompletions: () => {
				calls++;
				return [{ insertText: ' suggestion' }];
			},
		});
		const trigger = async (container: HTMLElement): Promise<void> => {
			container.querySelector('.stanza-editor-input')!.dispatchEvent(new KeyboardEvent('keydown', {
				key: ' ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
			}));
			await new Promise(resolve => setTimeout(resolve, 0));
		};
		const visible = (): number => document.querySelectorAll('.stanza-editor-inline-completion:not([hidden])').length;
		try {
			await trigger(callerContainer);
			await trigger(ownedContainer);
			const visibleBefore = visible();
			service.snooze(10_000);
			const visibleAfter = visible();
			const previousCalls = calls;
			await trigger(callerContainer);
			await trigger(ownedContainer);
			const callsWhilePaused = calls - previousCalls;
			ownedEditor.dispose();
			const pausedAfterDispose = service.isSnoozing();
			service.cancelSnooze();
			await trigger(callerContainer);
			return { shared: service === other, visibleBefore, visibleAfter, callsWhilePaused, pausedAfterDispose, resumed: visible() === 1 };
		} finally {
			service.cancelSnooze();
		}
	},
	runEmptyWordPattern: () => {
		using configuration = stanza.languages.setLanguageConfiguration('plaintext', { wordPattern: /foo|a*/gu });
		callerEditor.setValue('😀 foo');
		return callerModel.getWordAtPosition(new stanza.Position(1, 4));
	},
	runDisposedLanguageRequest: async kind => {
		const features = callerEditor.invokeWithinContext(accessor => accessor.get(ILanguageFeaturesService));
		let calls = 0;
		let signal: AbortSignal | undefined;
		let release!: () => void;
		let started!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const ready = new Promise<void>(resolve => { started = resolve; });
		const wait = async (requestSignal: AbortSignal): Promise<void> => {
			calls++;
			signal = requestSignal;
			started();
			await pending;
		};
		using provider = kind === 'codeAction'
			? features.codeActionProvider.register('plaintext', { provideCodeActions: async (_request, signal) => { await wait(signal); return []; } })
			: kind === 'rename'
				? features.renameProvider.register('plaintext', {
					prepareRename: async (_request, signal) => { await wait(signal); return undefined; },
					provideRenameEdits: () => ({ entries: [] }),
				})
				: features.signatureHelpProvider.register('plaintext', { signatureHelpTriggerCharacters: ['('], provideParameterHints: async (_request, signal) => { await wait(signal); return undefined; } });
		try {
			callerEditor.focus();
			const hints = kind === 'parameterHints' || kind === 'queuedParameterHints' ? callerEditor.getContribution('editor.controller.parameterHints') : undefined;
			if (kind === 'queuedParameterHints') {
				callerEditor.executeEdits('test', [{ range: new stanza.Range(1, 1, 1, 1), text: '(' }]);
			} else {
				const key = kind === 'rename' ? 'F2' : kind === 'codeAction' ? '.' : ' ';
				callerContainer.querySelector('.stanza-editor-input')!.dispatchEvent(new KeyboardEvent('keydown', {
					key, ctrlKey: kind !== 'rename', shiftKey: kind === 'parameterHints', bubbles: true, cancelable: true,
				}));
				await ready;
			}
			hints?.dispose();
			const aborted = signal?.aborted ?? false;
			if (!hints) callerEditor.dispose();
			release();
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			return { calls, aborted: hints ? aborted : signal?.aborted ?? false };
		} finally {
			release();
		}
	},
	runFormatterChoice: async outcome => {
		const language = callerModel.getLanguageId();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		callerEditor.setValue('alpha');
		callerEditor.setPosition(new stanza.Position(1, 1));
		const calls: string[] = [];
		const modes: number[] = [];
		const errors: string[] = [];
		const selected = stanza.languages.registerDocumentFormattingEditProvider('*', {
			provideDocumentFormattingEdits: model => {
				calls.push('selected');
				if (outcome === 'languageResult') callerModel.setLanguage('typescript');
				if (outcome === 'error') throw new Error('formatter failed');
				return outcome === 'empty' ? [] : [{ range: model.getFullModelRange(), text: 'SELECTED' }];
			},
		});
		const other = stanza.languages.registerDocumentFormattingEditProvider('*', {
			provideDocumentFormattingEdits: model => { calls.push('other'); return [{ range: model.getFullModelRange(), text: 'OTHER' }]; },
		});
		let choosing!: () => void;
		const started = new Promise<void>(resolve => { choosing = resolve; });
		const selector = FormattingConflicts.setFormatterSelector(async (providers, _model, mode, kind) => {
			if (kind !== FormattingKind.File) throw new Error('Unexpected formatting kind');
			modes.push(mode);
			choosing();
			if (outcome === 'cancel') return new Promise(() => {});
			if (outcome === 'languageChoice') await gate;
			return outcome === 'decline' ? undefined : providers[1];
		});
		try {
			const request = callerEditor.invokeWithinContext(accessor => formatEditor(
				callerEditor, accessor.get(ILanguageFeaturesService), accessor.get(IVersionedEditorWorkerClient),
				FormattingKind.File, outcome === 'silent' ? FormattingMode.Silent : FormattingMode.Explicit,
			)).catch(error => { errors.push((error as Error).message); });
			await started;
			if (outcome === 'cancel') callerEditor.setPosition(new stanza.Position(1, 3));
			if (outcome === 'languageChoice') callerModel.setLanguage('typescript');
			release();
			await request;
			return { value: callerEditor.getValue(), calls, modes, errors };
		} finally {
			selector.dispose();
			callerModel.setLanguage(language);
			other.dispose();
			selected.dispose();
		}
	},
	runOverlappingFormatting: async cancel => {
		callerEditor.setValue('alpha\nbeta\ngamma');
		callerEditor.setSelections([new stanza.Selection(1, 1, 1, 6), new stanza.Selection(3, 1, 3, 6)]);
		callerEditor.focus();
		const ranges: string[] = [];
		let cancelled = false;
		const provider = stanza.languages.registerDocumentRangeFormattingEditProvider('*', {
			provideDocumentRangeFormattingEdits: (model, range, _options, token) => {
				ranges.push(range.toString());
				if (range.startLineNumber !== range.endLineNumber) {
					if (cancel) {
						callerEditor.setSelections([new stanza.Selection(1, 1, 1, 6), new stanza.Selection(3, 2, 3, 6)]);
						cancelled = token.isCancellationRequested;
						return new Promise(() => {});
					}
					return [{ range, text: model.getValueInRange(range).toUpperCase() }];
				}
				return [{ range: model.getFullModelRange(), text: 'discard me', eol: EndOfLineSequence.CRLF }];
			},
		});
		try {
			await window.ashStandaloneIntegration.runLineAction('editor.action.formatSelection');
			return { value: callerEditor.getValue(), ranges, cancelled };
		} finally {
			provider.dispose();
		}
	},
	runSelectionFormatting: async mode => {
		callerEditor.setValue('alpha\nbeta\ngamma');
		callerEditor.setSelections(mode === 'empty'
			? [new stanza.Selection(2, 3, 2, 3)]
			: [new stanza.Selection(1, 1, 1, 6), new stanza.Selection(3, 1, 3, 6)]);
		callerEditor.focus();
		const ranges: string[] = [];
		let token: CancellationToken | undefined;
		let release!: () => void;
		const ready = new Promise<void>(resolve => { release = resolve; });
		let providerStarted!: () => void;
		const enteredProvider = new Promise<void>(resolve => { providerStarted = resolve; });
		const provide = async (selected: Range[], receivedToken: CancellationToken) => {
			token = receivedToken;
			ranges.push(...selected.map(range => range.toString()));
			providerStarted();
			if (mode === 'cancel') await ready;
			return selected.map(range => ({ range, text: callerModel.getValueInRange(range).toUpperCase() }));
		};
		const provider = stanza.languages.registerDocumentRangeFormattingEditProvider('*', {
			provideDocumentRangeFormattingEdits: (_model, range, _options, token) => provide([range], token),
			...(mode === 'single' ? {} : {
				provideDocumentRangesFormattingEdits: (_model: ITextModel, ranges: Range[], _options: { tabSize: number; insertSpaces: boolean }, token: CancellationToken) => provide(ranges, token),
			}),
		});
		try {
			if (mode === 'readonly') callerEditor.updateOptions({ readOnly: true });
			const request = window.ashStandaloneIntegration.runLineAction('editor.action.formatSelection');
			if (mode === 'cancel') {
				await enteredProvider;
				// Change the anchor while keeping the primary caret at the same position.
				callerEditor.setSelection(new stanza.Selection(1, 2, 1, 6));
			}
			release();
			await request;
			return { value: callerEditor.getValue(), ranges, cancelled: token?.isCancellationRequested ?? false };
		} finally {
			provider.dispose();
			callerEditor.updateOptions({ readOnly: false });
		}
	},
	prepareDeferredFormatting: () => {
		formattingProvider?.dispose();
		deferredFormatting = [];
		callerEditor.setValue('alpha');
		callerEditor.setPosition(new stanza.Position(1, 1));
		callerEditor.focus();
		formattingProvider = stanza.languages.registerDocumentFormattingEditProvider('*', {
			provideDocumentFormattingEdits: async (_model, _options, token) => {
				await new Promise<void>(resolve => deferredFormatting.push({ token, resolve }));
				return [{ range: new stanza.Range(1, 1, 1, 6), text: 'ALPHA' }];
			},
		});
	},
	readDeferredFormatting: () => ({ aborted: deferredFormatting.map(request => request.token.isCancellationRequested), value: callerEditor.getValue() }),
	finishDeferredFormatting: () => { for (const request of deferredFormatting) request.resolve(); },
	readEOL: () => callerEditor.getModel()!.getEOL(),
	runUnicodeFormatting: async (original, formatted) => {
		callerEditor.setValue(original);
		callerEditor.focus();
		const provider = stanza.languages.registerDocumentFormattingEditProvider('*', {
			provideDocumentFormattingEdits: () => [{ range: callerModel.getFullModelRange(), text: formatted }],
		});
		try {
			await window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument');
			return callerEditor.getValue();
		} finally {
			provider.dispose();
		}
	},
	runFormatting: async change => {
		callerEditor.setValue('alpha');
		callerEditor.setPosition(new stanza.Position(1, 1));
		callerEditor.focus();
		let release!: () => void;
		const ready = new Promise<void>(resolve => { release = resolve; });
		const provideEdits = async () => {
			await ready;
			return [{ range: new stanza.Range(1, 1, 1, 6), text: change === 'eol' ? 'alpha' : 'ALPHA', ...(change === 'eol' ? { eol: EndOfLineSequence.CRLF } : {}) }];
		};
		const provider = change === 'range'
			? stanza.languages.registerDocumentRangeFormattingEditProvider('*', { provideDocumentRangeFormattingEdits: provideEdits })
			: stanza.languages.registerDocumentFormattingEditProvider('*', { provideDocumentFormattingEdits: provideEdits });
		try {
			const formatting = window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument');
			if (change === 'position' || change === 'returnPosition') callerEditor.setPosition(new stanza.Position(1, 3));
			if (change === 'returnPosition') callerEditor.setPosition(new stanza.Position(1, 1));
			if (change === 'model') callerEditor.setModel(ownedModel);
			if (change === 'readonly') callerEditor.updateOptions({ readOnly: true });
			release();
			await formatting;
			return change === 'eol' ? callerEditor.getModel()!.getEOL() : callerEditor.getValue();
		} finally {
			provider.dispose();
			callerEditor.updateOptions({ readOnly: false });
			if (change === 'model') callerEditor.setModel(callerModel);
		}
	},
	prepareLineComment: options => {
		window.ashStandaloneIntegration.prepareLineCopy();
		callerModel.setLanguage(options?.languageId ?? 'typescript');
		callerEditor.updateOptions({ comments: { insertSpace: options?.insertSpace ?? true, ignoreEmptyLines: options?.ignoreEmptyLines ?? true }, readOnly: options?.readOnly ?? false });
		if (options?.value !== undefined) {
			callerEditor.setValue(options.value);
			callerEditor.setSelection(callerModel.getFullModelRange());
		}
	},
	prepareLineCopy: emptyTail => {
		callerEditor.setValue(emptyTail ? 'head\ntail\n' : 'alpha\nbeta\ngamma');
		callerEditor.setSelections(emptyTail
			? [new stanza.Selection(3, 1, 3, 1), new stanza.Selection(2, 3, 2, 1)]
			: [new stanza.Selection(3, 4, 3, 2), new stanza.Selection(1, 2, 1, 2)]);
		callerEditor.focus();
	},
	prepareBrackets: (value, columns, readOnly = false) => {
		callerEditor.updateOptions({ readOnly: false });
		callerEditor.setValue(value);
		callerModel.setLanguage('typescript');
		callerEditor.setSelections(columns.map(column => Array.isArray(column) ? new stanza.Selection(1, column[0], 1, column[1]) : new stanza.Selection(1, column, 1, column)));
		callerEditor.updateOptions({ readOnly });
		callerEditor.focus();
	},
	configureBracketColors: (enabled, independent) => {
		callerModel.updateOptions({ bracketColorizationOptions: { enabled: true, independentColorPoolPerBracketType: independent } });
		callerEditor.updateOptions({ bracketPairColorization: { enabled }, guides: { bracketPairs: true } });
	},
	setBracketTheme: (scheme, colors) => {
		stanza.editor.defineNamedTheme('bracket-test', {
			label: 'Bracket test',
			colorScheme: stanza.ColorScheme[scheme],
			colors: colors && Object.fromEntries(colors.map((color, index) => [`editorBracketHighlight.foreground${index + 1}`, color])),
		});
		stanza.editor.setTheme('bracket-test');
	},
	prepareBracketToken: () => {
		bracketTokenRegistration?.dispose();
		bracketTokenRegistration = stanza.languages.registerSyntaxProvider({
			id: 'bracket-color-test',
			languageIds: ['typescript'],
			provideTokens: request => ({ tokens: [{
				range: new stanza.Range(1, 1, 1, request.snapshot.getText().length + 1),
				tokenType: 'other', modifiers: [], presentation: { foreground: '#123456', fontStyle: ['bold'] },
			}] }),
		});
	},
	prepareGuides: value => {
		callerEditor.setValue(value);
		callerModel.setLanguage('typescript');
		callerModel.updateOptions({ tabSize: 4, indentSize: 2, bracketColorizationOptions: { enabled: true, independentColorPoolPerBracketType: false } });
		callerEditor.updateOptions({
			lineHeight: 20,
			wordWrap: 'off',
			guides: { indentation: true, highlightActiveIndentation: 'always', bracketPairs: true, bracketPairsHorizontal: true, highlightActiveBracketPair: true },
		});
		callerEditor.setPosition(new stanza.Position(1, 1));
		callerEditor.focus();
	},
	configureGuides: options => callerEditor.updateOptions(options),
	setGuideTheme: (scheme, colors) => {
		stanza.editor.defineNamedTheme('guide-test', { label: 'Guide test', colorScheme: stanza.ColorScheme[scheme], colors });
		stanza.editor.setTheme('guide-test');
	},
	prepareLineJoin: () => {
		callerEditor.setValue('😀 one\r\n  two\r\nkeep\r\n三\r\n  four');
		callerEditor.setSelections([new stanza.Selection(4, 2, 4, 2), new stanza.Selection(1, 3, 1, 3)]);
		callerEditor.focus();
	},
	prepareMulticursor: () => {
		callerEditor.setValue('alpha\nbeta');
		callerEditor.setSelection(new stanza.Selection(1, 1, 2, 5));
		callerEditor.focus();
	},
	runEditorActivity: async () => {
		const editors = StandaloneServices.get().instantiationService.get(ICodeEditorService);
		const outside = document.createElement('button');
		const container = document.createElement('div');
		document.body.append(outside, container);
		callerEditor.focus();
		ownedEditor.focus();
		callerEditor.focus();
		const third = stanza.editor.create(container, { value: 'third' });
		try {
			outside.focus();
			await new Promise(resolve => setTimeout(resolve, 0));
			const creationPreservesActive = editors.getActiveCodeEditor() === callerEditor;
			callerEditor.setModel(null);
			callerEditor.setModel(callerModel);
			callerEditor.focus();
			outside.focus();
			await new Promise(resolve => setTimeout(resolve, 0));
			const switchPreservesActive = editors.getActiveCodeEditor() === callerEditor;
			callerEditor.dispose();
			const removalRestoresRecent = editors.getActiveCodeEditor() === ownedEditor;
			editors.removeCodeEditor(ownedEditor);
			ownedEditor.focus();
			const removedEditorIgnored = editors.getActiveCodeEditor() === third;
			return [creationPreservesActive, switchPreservesActive, removalRestoresRecent, removedEditorIgnored];
		} finally {
			third.dispose();
			container.remove();
			outside.remove();
		}
	},
	runHistoryCommands: async useAlias => {
		const services = StandaloneServices.get().instantiationService;
		const outside = document.createElement('button');
		document.body.append(outside);
		callerEditor.setValue('alpha');
		ownedEditor.setValue('bravo');
		callerEditor.focus();
		callerEditor.executeEdits('test', [{ range: new stanza.Range(1, 6, 1, 6), text: '!' }]);
		callerEditor.pushUndoStop();
		const values: string[] = [];
		const run = async (operation: 'undo' | 'redo'): Promise<void> => {
			const command = CommandsRegistry.getCommand(useAlias ? `default:${operation}` : operation)!;
			await services.invokeFunction(accessor => command(accessor));
			values.push(`${callerEditor.getValue()}|${ownedEditor.getValue()}`);
		};
		try {
			await run('undo');
			callerEditor.updateOptions({ readOnly: true });
			await run('redo');
			callerEditor.updateOptions({ readOnly: false });
			outside.focus();
			await new Promise(resolve => setTimeout(resolve, 0));
			await run('redo');
			callerEditor.updateOptions({ readOnly: true });
			await run('undo');
			callerEditor.updateOptions({ readOnly: false });
			callerEditor.getContribution<FindController>(FindController.ID)!.open({ showReplace: true });
			callerEditor.getDomNode()!.querySelector<HTMLInputElement>('input[aria-label="Find"]')!.focus();
			await run('undo');
			callerEditor.focus();
			await run('undo');
			return values;
		} finally {
			callerEditor.updateOptions({ readOnly: false });
			outside.remove();
		}
	},
	prepareInputHistory: () => {
		callerEditor.setValue('alpha');
		ownedEditor.setValue('bravo');
		callerEditor.focus();
		callerEditor.executeEdits('test', [{ range: new stanza.Range(1, 6, 1, 6), text: '!' }]);
		callerEditor.pushUndoStop();
		callerEditor.updateOptions({ readOnly: true });
		callerEditor.getContribution<FindController>(FindController.ID)!.open({ showReplace: true });
	},
	runInputHistoryCommand: async id => {
		const command = CommandsRegistry.getCommand(id)!;
		await StandaloneServices.get().instantiationService.invokeFunction(accessor => command(accessor));
		return [callerEditor.getValue(), ownedEditor.getValue()];
	},
	runSelectAllCommand: async () => {
		const services = StandaloneServices.get().instantiationService;
		const command = CommandsRegistry.getCommand('editor.action.selectAll')!;
		const outside = document.createElement('button');
		document.body.append(outside);
		callerEditor.setValue('one\ntwo');
		ownedEditor.setValue('other');
		ownedEditor.setPosition({ lineNumber: 1, column: 2 });
		callerEditor.focus();
		const selections: string[] = [];
		const run = async (): Promise<void> => {
			await services.invokeFunction(accessor => command(accessor));
			selections.push(`${callerEditor.getSelection()}|${ownedEditor.getSelection()}`);
		};
		try {
			await run();
			callerEditor.setPosition({ lineNumber: 1, column: 2 });
			callerEditor.updateOptions({ readOnly: true });
			outside.focus();
			await new Promise(resolve => setTimeout(resolve, 0));
			await run();
			callerEditor.setPosition({ lineNumber: 1, column: 2 });
			callerEditor.getContribution<FindController>(FindController.ID)!.open({ showReplace: true });
			const input = callerEditor.getDomNode()!.querySelector<HTMLInputElement>('input[aria-label="Find"]')!;
			input.value = 'needle';
			input.focus();
			input.setSelectionRange(2, 2);
			await run();
			return { selections, inputSelection: input.value.slice(input.selectionStart!, input.selectionEnd!) };
		} finally {
			callerEditor.updateOptions({ readOnly: false });
			outside.remove();
		}
	},
	runFocusRouting: async () => {
		callerEditor.setValue('alpha');
		ownedEditor.setValue('bravo');
		const outside = document.createElement('button');
		outside.textContent = 'Editor action';
		document.body.append(outside);
		outside.focus();
		await new Promise(resolve => setTimeout(resolve, 0));
		using listeners = new DisposableStore();
		const events: string[] = [];
		listeners.add(callerEditor.onDidFocusEditorWidget(() => events.push('focus')));
		listeners.add(callerEditor.onDidBlurEditorWidget(() => events.push('blur')));
		const observed = observableCodeEditor(callerEditor);
		const states: { stage: string; text: boolean; widget: boolean; observedText: boolean; observedWidget: boolean; contextText: boolean; contextWidget: boolean; widgetEvents: string }[] = [];
		const read = (stage: string): void => {
			const context = callerEditor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
			states.push({
				stage, text: callerEditor.hasTextFocus(), widget: callerEditor.hasWidgetFocus(),
				observedText: observed.isTextFocused.get(), observedWidget: observed.isFocused.get(),
				contextText: context.getValue<boolean>('editorTextFocus') ?? false,
				contextWidget: context.getValue<boolean>('editorFocus') ?? false,
				widgetEvents: events.join(','),
			});
		};
		try {
			callerEditor.focus();
			read('text');
			callerEditor.getContribution<FindController>(FindController.ID)!.open({ showReplace: true });
			await new Promise(resolve => setTimeout(resolve, 0));
			read('find');
			callerEditor.getDomNode()!.querySelector<HTMLInputElement>('input[aria-label="Replace"]')!.focus();
			await new Promise(resolve => setTimeout(resolve, 0));
			read('replace');
			outside.focus();
			await new Promise(resolve => setTimeout(resolve, 0));
			read('outside');
			const services = StandaloneServices.get().instantiationService;
			const editors = services.get(ICodeEditorService);
			const activeAfterBlur = editors.getActiveCodeEditor() === callerEditor;
			const action = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === 'editor.action.copyLinesDownAction');
			if (!action) throw new Error('Copy line action is unavailable');
			await services.invokeFunction(accessor => action.runCommand(accessor, undefined));
			const values = [callerEditor.getValue(), ownedEditor.getValue()];
			callerEditor.dispose();
			await new Promise(resolve => setTimeout(resolve, 0));
			return { states, events, activeAfterBlur, values, activeAfterDispose: editors.getActiveCodeEditor() === ownedEditor };
		} finally {
			outside.remove();
		}
	},
	runDeferredRichCopy: async fail => {
		callerEditor.setValue('const value = 1;');
		callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
		callerEditor.updateOptions({ copyWithSyntaxHighlighting: false });
		callerEditor.focus();
		const clipboard = callerEditor.invokeWithinContext(accessor => accessor.get(IClipboardService));
		const writeText = clipboard.writeText;
		const execCommand = document.execCommand;
		let finishTransfer!: () => void;
		const transfer = new Promise<void>(resolve => { finishTransfer = resolve; });
		let writtenText = '';
		clipboard.writeText = async text => {
			writtenText = text;
			await transfer;
			if (fail) throw new Error('Clipboard write rejected');
		};
		document.execCommand = () => false;
		try {
			const action = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === 'editor.action.clipboardCopyWithSyntaxHighlightingAction');
			if (!action) throw new Error('Rich copy action is unavailable');
			const completion = Promise.resolve(callerEditor.invokeWithinContext(accessor => action.runEditorCommand(accessor, callerEditor, {}))).then(() => false, () => true);
			const input = document.activeElement!;
			const pendingData = new DataTransfer();
			input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: pendingData }));
			finishTransfer();
			const rejected = await completion;
			const finishedData = new DataTransfer();
			input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: finishedData }));
			return { pendingHtml: pendingData.getData('text/html'), finishedHtml: finishedData.getData('text/html'), rejected, writtenText };
		} finally {
			finishTransfer();
			clipboard.writeText = writeText;
			document.execCommand = execCommand;
		}
	},
	runActiveClipboard: async (command, target) => {
		callerEditor.setValue('alpha');
		ownedEditor.setValue('bravo');
		callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
		ownedEditor.focus();
		callerEditor.focus();
		callerEditor.updateOptions({ readOnly: target === 'readonly' });
		const outside = document.createElement('button');
		document.body.append(outside);
		const clipboard = StandaloneServices.get().instantiationService.get(IClipboardService);
		const readText = clipboard.readText;
		const writeText = clipboard.writeText;
		const execCommand = document.execCommand;
		let written = '';
		let reads = 0;
		const documentCommands: string[] = [];
		clipboard.readText = async () => { reads++; return 'omega'; };
		clipboard.writeText = async text => { written = text; };
		document.execCommand = command => { documentCommands.push(command); return false; };
		try {
			if (target === 'find') {
				callerEditor.getContribution<FindController>(FindController.ID)!.open({ showReplace: true });
				callerEditor.getDomNode()!.querySelector<HTMLInputElement>('input[aria-label="Find"]')!.focus();
			} else {
				outside.focus();
			}
			await new Promise(resolve => setTimeout(resolve, 0));
			const id = { copy: 'editor.action.clipboardCopyAction', cut: 'editor.action.clipboardCutAction', paste: 'editor.action.clipboardPasteAction' }[command];
			const action = CommandsRegistry.getCommand(id)!;
			await StandaloneServices.get().instantiationService.invokeFunction(accessor => action(accessor));
			return { values: [callerEditor.getValue(), ownedEditor.getValue()], written, reads, focused: callerEditor.hasTextFocus(), documentCommands };
		} finally {
			clipboard.readText = readText;
			clipboard.writeText = writeText;
			document.execCommand = execCommand;
			callerEditor.updateOptions({ readOnly: false });
			outside.remove();
		}
	},
	runDeferredClipboard: async (command, change, fromOutside) => {
		callerEditor.setValue('alpha');
		callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
		callerEditor.focus();
		const outside = document.createElement('button');
		document.body.append(outside);
		if (fromOutside) outside.focus();
		const clipboard = callerEditor.invokeWithinContext(accessor => accessor.get(IClipboardService));
		const readText = clipboard.readText;
		const writeText = clipboard.writeText;
		const execCommand = document.execCommand;
		let finishTransfer!: () => void;
		const transfer = new Promise<void>(resolve => { finishTransfer = resolve; });
		clipboard.readText = async () => { await transfer; return 'omega'; };
		clipboard.writeText = async () => { await transfer; };
		if (command === 'cut') {
			document.execCommand = () => false;
		}
		try {
			const action = command === 'cut' ? CutAction : PasteAction;
			if (!action) throw new Error('Clipboard command is unavailable');
			let finished = false;
			const completion = Promise.resolve(callerEditor.invokeWithinContext(accessor => action.runCommand(accessor, undefined))).then(() => { finished = true; });
			const input = document.activeElement!;
			if (change === 'selection') {
				callerEditor.setPosition(new stanza.Position(1, 3));
				callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
			} else if (change === 'focus') {
				ownedEditor.focus();
				callerEditor.focus();
			} else if (change === 'readonly') {
				callerEditor.updateOptions({ readOnly: true });
				callerEditor.updateOptions({ readOnly: false });
			} else if (change === 'composition') {
				const target = input instanceof HTMLTextAreaElement ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
				if (!target) throw new Error('Composition target is unavailable');
				target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
				target.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
			} else if (change === 'escape') {
				input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			} else if (change === 'model') {
				callerEditor.setModel(null);
				callerEditor.setModel(callerModel);
				callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
			} else if (change === 'dispose') {
				callerEditor.dispose();
			}
			await new Promise(resolve => setTimeout(resolve, 0));
			const finishedBeforeTransfer = finished;
			finishTransfer();
			await completion;
			return { value: callerModel.getValue(), finishedBeforeTransfer };
		} finally {
			finishTransfer();
			outside.remove();
			clipboard.readText = readText;
			clipboard.writeText = writeText;
			document.execCommand = execCommand;
		}
	},
	runDeferredPaste: async change => {
		callerEditor.setValue('alpha');
		callerEditor.setPosition(new stanza.Position(1, 6));
		callerEditor.focus();
		let resolveFile!: (text: string) => void;
		const pending = new Promise<string>(resolve => { resolveFile = resolve; });
		const file = new File(['pending'], 'snippet.txt', { type: 'text/plain' });
		Object.defineProperty(file, 'text', { value: () => pending });
		const clipboardData = new DataTransfer();
		clipboardData.items.add(file);
		const input = document.activeElement!;
		const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
		input.dispatchEvent(event);
		let finished = false;
		const completion = CopyPasteController.get(callerEditor)!.finishedPaste().then(() => { finished = true; });
		if (change === 'writableAgain') {
			callerEditor.updateOptions({ readOnly: true });
			callerEditor.updateOptions({ readOnly: false });
		} else if (change === 'selection') {
			callerEditor.setPosition(new stanza.Position(1, 1));
			callerEditor.setPosition(new stanza.Position(1, 6));
		} else if (change === 'composition') {
			const target = input instanceof HTMLTextAreaElement ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
		} else if (change === 'escape') {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		}
		await new Promise(resolve => setTimeout(resolve, 0));
		const finishedBeforeDecode = finished;
		resolveFile(' file');
		await completion;
		return { value: callerEditor.getValue(), handled: event.defaultPrevented, finishedBeforeDecode };
	},
	runDeferredDrop: async change => {
		callerEditor.setValue('alpha');
		callerEditor.setPosition(new stanza.Position(1, 1));
		callerEditor.focus();
		const before = callerEditor.getSelection()!.toString();
		let resolveFile!: (text: string) => void;
		const pending = new Promise<string>(resolve => { resolveFile = resolve; });
		const file = new File(['pending'], 'snippet.txt', { type: 'text/plain' });
		Object.defineProperty(file, 'text', { value: () => pending });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		const node = callerEditor.getDomNode()!;
		const bounds = node.getBoundingClientRect();
		const position = callerEditor.getScrolledVisiblePosition(new stanza.Position(1, 6))!;
		const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + position.left, clientY: bounds.top + position.top + position.height / 2 });
		node.dispatchEvent(event);
		try {
			if (change !== 'none') callerEditor.updateOptions({ readOnly: true });
			if (change === 'writableAgain') callerEditor.updateOptions({ readOnly: false });
			resolveFile(' file');
			await new Promise(resolve => setTimeout(resolve, 0));
			return { value: callerEditor.getValue(), selectionUnchanged: callerEditor.getSelection()!.toString() === before, handled: event.defaultPrevented };
		} finally {
			callerEditor.updateOptions({ readOnly: false });
		}
	},
	runScopedActions: async () => {
		callerEditor.setValue('alpha\nbeta\ngamma');
		callerEditor.setPosition({ lineNumber: 1, column: 1 });
		callerEditor.updateOptions({ readOnly: true });
		ownedEditor.focus();
		const context = callerEditor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
		const action = callerEditor.getAction('editor.action.deleteLines')!;
		const supported = [action.isSupported()];
		await action.run();
		const values = [callerEditor.getValue()];
		callerEditor.updateOptions({ readOnly: false });
		supported.push(action.isSupported());
		await action.run();
		values.push(callerEditor.getValue());
		callerEditor.setModel(null);
		await action.run();
		callerEditor.setModel(callerModel);
		await action.run();
		values.push(callerEditor.getValue());
		return {
			supported, values, otherValue: ownedEditor.getValue(),
			sameContext: context === callerEditor.invokeWithinContext(accessor => accessor.get(IContextKeyService)),
			focusRetained: ownedEditor.hasTextFocus(),
		};
	},
	runLineAction: async id => {
		const action = callerEditor.getAction(id);
		if (!action) throw new Error(`Missing editor action: ${id}`);
		await action.run();
	},
	readLineCopy: () => ({ value: callerEditor.getValue(), selections: (callerEditor.getSelections() ?? []).map(selection => selection.toString()) }),
	updateRenderingOptions: enabled => {
		callerEditor.updateOptions({
			minimap: { enabled, side: 'left', showSlider: 'always' },
			mouseStyle: enabled ? 'copy' : 'default',
			fontSize: enabled ? 18 : 14,
			wordWrap: enabled ? 'on' : 'off',
		});
		return callerModel.getVersionId();
	},
	prepareReferencePreview: () => {
		callerEditor.setValue('alpha beta\nalpha gamma');
		callerEditor.setPosition(new stanza.Position(1, 2));
		referenceRegistration?.dispose();
		referenceRegistration = stanza.languages.registerReferenceProvider('plaintext', {
			provideReferences: () => [
				{ resource: callerResource, range: new stanza.Range(1, 1, 1, 6) },
				{ resource: callerResource, range: new stanza.Range(2, 1, 2, 6) },
			],
		});
	},
	setParentFontSize: () => callerEditor.updateOptions({ fontSize: 18 }),
	setTestMarkers: enabled => {
		const markers = StandaloneServices.get().instantiationService.get(IMarkerService);
		if (enabled) markers.set('integration', [{ resource: callerResource, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 3 } }, severity: MarkerSeverity.Error, message: 'Test marker' }]);
		else markers.remove('integration');
	},
	setMinimapColor: color => {
		callerEditor.setValue('abcdefghijk');
		callerEditor.updateOptions({ minimap: { enabled: true } });
		TokenizationRegistry.setColorMap([Color.fromHex('#000000'), Color.fromHex(color), Color.fromHex('#ffffff')]);
	},
	readMinimapPixel: () => {
		const canvas = callerContainer.querySelector<HTMLCanvasElement>('.minimap canvas')!;
		const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
		for (let index = 0; index < data.length; index += 4) {
			if (data[index + 3] > 0) return Array.from(data.slice(index, index + 4));
		}
		return [];
	},
	checkContracts: async () => {
		const host = h(document, 'div');
		document.body.append(host);
		const instance = stanza.editor.create(host, { value: 'long text '.repeat(100) + '\n' + 'line\n'.repeat(100), wordWrap: 'on', smoothScrolling: true });
		const eventTexts: string[] = [];
		const listener = instance.onDidChangeModelContent(event => eventTexts.push(...event.changes.map(change => change.text)));
		try {
			instance.layout({ width: 260, height: 100 });
			const wrapping = instance.getOption(EditorOption.wordWrap);
			const wrapped = instance.getTopForLineNumber(2) > instance.getOption(EditorOption.lineHeight);
			instance.setScrollTop(600, ScrollType.Smooth);
			const animated = instance.hasPendingScrollAnimation();
			const deadline = performance.now() + 2000;
			while (instance.hasPendingScrollAnimation() && performance.now() < deadline) {
				await new Promise<void>(resolve => scheduleAtNextAnimationFrame(window, () => resolve()));
			}
			const settled = !instance.hasPendingScrollAnimation();
			const top = instance.getScrollTop();
			instance.setScrollTop(900, ScrollType.Smooth);
			const root = instance.getDomNode()!;
			root.scrollTop = 200;
			root.dispatchEvent(new Event('scroll'));
			const interrupted = !instance.hasPendingScrollAnimation() && instance.getScrollTop() === 200;
			instance.executeEdits('test', [{ range: new stanza.Range(1, 1, 1, 1), text: 'X' }]);
			instance.setModel(null);
			instance.changeViewZones(() => { throw new Error('Detached callback must not run'); });
			instance.restoreViewState(null);
			const detached = instance.saveViewState() === null && !instance.hasPendingScrollAnimation();
			return { wrapping, wrapped, animated, settled, top, interrupted, detached, eventTexts };
		} finally {
			listener.dispose();
			instance.dispose();
			host.remove();
		}
	},
	events,
	state,
	switchOwnedToCaller: () => {
		const root = ownedEditor.getDomNode();
		ownedEditor.setModel(callerModel);
		return {
			ownedModelDisposed: ownedModel.isDisposed(),
			ownedModelRegistered: stanza.editor.getModel(ownedResource) !== null,
			rootRetained: ownedEditor.getDomNode() === root,
			editorCount: stanza.editor.getEditors().length,
			currentModelIsCaller: ownedEditor.getModel() === callerModel,
		};
	},
	detachOwned: () => {
		ownedEditor.setModel(null);
		return {
			modelIsNull: ownedEditor.getModel() === null,
			value: ownedEditor.getValue(),
			rootMounted: ownedContainer.contains(ownedEditor.getDomNode()),
			inputCount: ownedContainer.querySelectorAll('.stanza-editor-input').length,
		};
	},
	reattachOwned: () => ownedEditor.setModel(callerModel),
	getOwnedValue: () => ownedEditor.getValue(),
	getCallerVersion: () => callerModel.getVersionId(),
	tryOverlappingSurrogateEdits: () => {
		callerEditor.setValue('a📚b');
		const version = callerModel.getVersionId();
		let rejected = false;
		try {
			callerEditor.executeEdits('browser', [
				{ range: new stanza.Range(1, 2, 1, 3), text: 'X' },
				{ range: new stanza.Range(1, 3, 1, 4), text: 'Y' },
			]);
		} catch (error) {
			if (!(error instanceof Error) || !/overlap/u.test(error.message)) throw error;
			rejected = true;
		}
		return { rejected, value: callerModel.getValue(), versionUnchanged: callerModel.getVersionId() === version };
	},
	applySurrogateEdit: () => {
		callerEditor.executeEdits('browser', [{ range: new stanza.Range(1, 2, 1, 3), text: '' }]);
		return callerModel.getValue();
	},
	resetSameValue: () => {
		callerEditor.setValue('stable');
		const snapshot = callerModel.createSnapshot();
		const beforeVersion = callerModel.getVersionId();
		const events: Array<{ readonly version: number; readonly reason: string; readonly changes: number }> = [];
		using listener = callerModel.onDidChangeContent(change => events.push({
			version: change.version,
			reason: change.reason,
			changes: change.changes.length,
		}));
		callerEditor.setValue('stable');
		return {
			beforeVersion,
			afterVersion: callerModel.getVersionId(),
			alternativeVersion: callerModel.getAlternativeVersionId(),
			snapshotValue: snapshot.read(),
			events,
		};
	},
	prepareSelectionUndo: () => {
		callerEditor.setValue('alpha\nbeta');
		callerEditor.setSelections([
			new stanza.Selection(1, 6, 1, 1),
			new stanza.Selection(2, 1, 2, 5),
		]);
		ownedEditor.setSelections([new stanza.Selection(2, 3, 2, 3)]);
		return readSelectionUndo();
	},
	applySelectionEdit: () => {
		callerEditor.pushUndoStop();
		callerEditor.executeEdits('browser', [
			{ range: new stanza.Range(1, 1, 1, 6), text: 'A' },
			{ range: new stanza.Range(2, 1, 2, 5), text: 'B' },
		], [
			new stanza.Selection(1, 2, 1, 2),
			new stanza.Selection(2, 2, 2, 2),
		]);
		callerEditor.pushUndoStop();
		return readSelectionUndo();
	},
	readSelectionUndo,
	enableCodeActions: () => {
		codeActionRegistration?.dispose();
		codeActionRegistration = stanza.languages.registerCodeActionProvider('plaintext', {
			provideCodeActions: () => [{ title: 'Example code action' }],
		});
	},
	prepareLineIdentity: () => {
		callerEditor.setValue('a\nlonger');
		if (!(callerModel instanceof stanza.TextModel)) throw new Error('Line identity model is unavailable');
		longLineId = callerModel.getLineId(1);
		return readLineIdentity();
	},
	splitLineIdentity: () => {
		callerEditor.executeEdits('browser', [{ range: new stanza.Range(1, 2, 1, 2), text: '\n' }]);
		return readLineIdentity();
	},
	readLineIdentity,
	openLargeModel: () => {
		const value = Array(20_500).fill('x'.repeat(1_024)).join('\n');
		largeModel = stanza.editor.createModel(value, 'plaintext', stanza.URI.parse('inmemory://stanza/large.txt'));
		const snapshot = largeModel.createSnapshot();
		callerEditor.setModel(largeModel);
		ownedEditor.setModel(largeModel);
		return {
			textUnits: largeModel.getValueLength(),
			lineCount: largeModel.getLineCount(),
			tooLargeForTokenization: largeModel.isTooLargeForTokenization(),
			tooLargeForSynchronization: largeModel.isTooLargeForSyncing(),
			attachedEditors: largeModel.getAttachedEditorCount(),
			firstChunkPrefix: snapshot.read()?.slice(0, 32) ?? '',
		};
	},
	enableCompletionNavigation: snippet => {
		completionRegistration?.dispose();
		completionRegistration = stanza.languages.registerCompletionItemProvider('plaintext', {
			id: 'standalone.keyboard-navigation',
			provideCompletions: request => ({
				items: ['constant', 'console'].map(label => ({
					id: label,
					label,
					kind: stanza.languages.LanguageCompletionItemKind.Text,
					range: stanza.Range.fromPositions(request.position),
					insertText: snippet ?? label,
					insertTextFormat: snippet !== undefined ? stanza.languages.LanguageCompletionInsertTextFormat.Snippet : stanza.languages.LanguageCompletionInsertTextFormat.PlainText,
				})),
				isIncomplete: false,
			}),
		});
		callerEditor.setValue('con');
		callerEditor.setPosition(new stanza.Position(1, 4));
	},
	getCallerPosition: () => {
		const position = callerEditor.getPosition();
		return position ? { lineNumber: position.lineNumber, column: position.column } : null;
	},
	prepareKeyboardEditing: () => {
		callerEditor.setValue('first\nsecond');
		callerEditor.setPosition(new stanza.Position(1, 3));
		return readKeyboardEditing();
	},
	readKeyboardEditing,
	selectRange: () => {
		callerEditor.setSelection({ startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 4 });
		return readKeyboardEditing();
	},
	configureClipboardTokens: (highlighting, colorsAvailable = true) => {
		callerEditor.updateOptions({ copyWithSyntaxHighlighting: highlighting });
		callerModel.setLanguage('typescript');
		TokenizationRegistry.setColorMap((colorsAvailable ? ['#000000', '#222222', '#ffffff', '#123456', '#654321'] : ['#000000', '#222222', '#ffffff']).map(Color.fromHex));
		const keyword = MetadataConsts.SEMANTIC_USE_FOREGROUND | MetadataConsts.SEMANTIC_USE_BOLD | MetadataConsts.SEMANTIC_USE_ITALIC
			| (3 << MetadataConsts.FOREGROUND_OFFSET) | ((FontStyle.Bold | FontStyle.Italic) << MetadataConsts.FONT_STYLE_OFFSET);
		const string = MetadataConsts.SEMANTIC_USE_FOREGROUND | MetadataConsts.SEMANTIC_USE_UNDERLINE
			| (4 << MetadataConsts.FOREGROUND_OFFSET) | (FontStyle.Underline << MetadataConsts.FONT_STYLE_OFFSET);
		callerModel.tokenization.setSemanticTokens([SparseMultilineTokens.create(1, new Uint32Array([0, 0, 5, keyword, 1, 1, 8, string]))], true);
	},
	prepareClipboard: (value = 'alpha beta', selections = [[1, 1, 1, 6]], emptySelectionClipboard = true) => {
		callerEditor.updateOptions({ emptySelectionClipboard });
		callerEditor.setValue(value);
		callerEditor.setSelections(selections.map(selection => new stanza.Selection(...selection)));
		return readKeyboardEditing();
	},
	prepareWrappedLayout: () => {
		callerContainer.style.width = '120px';
		callerContainer.style.height = '80px';
		callerEditor.layout({ width: 120, height: 80 });
		callerEditor.updateOptions({ wordWrap: 'on', wrappingIndent: 'none' });
		callerEditor.setValue('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
		callerEditor.setPosition(new stanza.Position(1, 1));
		return readWrappedLayout();
	},
	prepareProportionalWrap: () => {
		callerContainer.style.width = '320px';
		callerContainer.style.height = '80px';
		callerEditor.layout({ width: 320, height: 80 });
		callerEditor.updateOptions({ fontFamily: 'Arial', wordWrap: 'wordWrapColumn', wordWrapColumn: 6, wrappingIndent: 'none' });
		callerEditor.setValue('abc defgh');
		return readWrappedLayout();
	},
	resizeWrappedLayout: width => {
		callerContainer.style.width = `${width}px`;
		callerEditor.layout({ width, height: 80 });
		return readWrappedLayout();
	},
	editWrappedText: value => {
		callerEditor.executeEdits('wrap', [{ range: new stanza.Range(1, 1, 1, callerModel.getLineMaxColumn(1)), text: value }]);
		return readWrappedLayout();
	},
	readWrappedLayout,
	prepareViewZone: unit => {
		callerEditor.updateOptions({ lineHeight: 20, padding: { top: 0, bottom: 0 }, scrollBeyondLastLine: false });
		callerEditor.setValue(['first', 'second', ...Array.from({ length: 10 }, (_, index) => `line-${index + 3}`)].join('\n'));
		callerEditor.setPosition(new stanza.Position(2, 1));
		callerEditor.createDecorationsCollection([{
			range: new stanza.Range(2, 1, 2, 7),
			options: { description: 'view zone geometry', blockClassName: 'ash-zone-block-probe' },
		}]);
		const domNode = h(document, 'div');
		domNode.className = 'ash-zone-probe';
		const marginDomNode = h(document, 'div');
		marginDomNode.className = 'ash-zone-margin-probe';
		viewZone = {
			afterLineNumber: 1,
			domNode,
			marginDomNode,
			suppressMouseDown: true,
			onComputedHeight(height) {
				computedZoneHeights.push(height);
				this.domNode.dataset.computedHeight = String(height);
			},
			onDomNodeTop(top) {
				this.domNode.dataset.top = String(top);
			},
		};
		if (unit === 'pixels') {
			viewZone.heightInPx = 0;
		} else {
			viewZone.heightInLines = 0;
		}
		callerEditor.changeViewZones(accessor => { viewZoneId = accessor.addZone(viewZone!); });
		return readViewZone();
	},
	prepareFoldedViewZone: showInHiddenAreas => {
		callerEditor.updateOptions({ lineHeight: 20, padding: { top: 0, bottom: 0 }, wordWrap: 'wordWrapColumn', wordWrapColumn: 10, wrappingIndent: 'none', showFoldingControls: 'always', scrollBeyondLastLine: false });
		callerEditor.setValue(['abcdefghijklmnopqrstuvwxy', '  x', '  y', ...Array.from({ length: 30 }, () => 'tail')].join('\n'));
		callerEditor.setPosition(new stanza.Position(1, 1));
		const domNode = h(document, 'div');
		domNode.className = 'ash-folded-zone-probe';
		const marginDomNode = h(document, 'div');
		marginDomNode.className = 'ash-folded-zone-margin-probe';
		callerEditor.changeViewZones(accessor => accessor.addZone({
			afterLineNumber: 2,
			heightInPx: 40,
			showInHiddenAreas,
			domNode,
			marginDomNode,
			onComputedHeight(height) {
				this.domNode.dataset.computedHeight = String(height);
			},
			onDomNodeTop(top) {
				this.domNode.dataset.top = String(top);
			},
		}));
		return callerModel.getVersionId();
	},
	resizeViewZone: (height, afterLineNumber) => {
		if (!viewZone) throw new Error('View zone has not been created');
		if (viewZone.heightInPx !== undefined) {
			viewZone.heightInPx = height;
		} else {
			viewZone.heightInLines = height;
		}
		viewZone.afterLineNumber = afterLineNumber;
		callerEditor.changeViewZones(accessor => accessor.layoutZone(viewZoneId));
		return readViewZone();
	},
	removeViewZone: () => {
		callerEditor.changeViewZones(accessor => accessor.removeZone(viewZoneId));
		return readViewZone();
	},
	prepareVisibleRows: () => {
		callerContainer.style.height = '80px';
		callerEditor.layout({ width: callerContainer.clientWidth, height: 80 });
		callerEditor.setValue(Array.from({ length: 80 }, (_, index) => `line-${String(index).padStart(2, '0')}`).join('\n'));
		return { lineCount: callerModel.getLineCount(), version: callerModel.getVersionId() };
	},
	scrollVisibleRows: top => {
		callerEditor.setScrollTop(top);
		return callerEditor.getScrollTop();
	},
	editVisibleRow: lineIndex => {
		const lineNumber = lineIndex + 1;
		callerEditor.executeEdits('visible-row', [{
			range: new stanza.Range(lineNumber, 1, lineNumber, callerModel.getLineMaxColumn(lineNumber)),
			text: `changed-${lineIndex}`,
		}]);
		return callerModel.getLineContent(lineNumber);
	},
	prepareCursorGutter: () => {
		callerContainer.style.width = '220px';
		callerContainer.style.height = '320px';
		callerEditor.layout({ width: 220, height: 320 });
		callerEditor.updateOptions({ wordWrap: 'on', lineNumbers: 'relative', glyphMargin: true, cursorBlinking: 'solid' });
		callerEditor.setValue('abcdefghijklmnopqrstuvwxyz0123456789\nnext');
		callerEditor.setPosition(new stanza.Position(1, callerModel.getLineMaxColumn(1)));
		callerEditor.createDecorationsCollection([{
			range: new stanza.Range(1, 1, 1, 1),
			options: { description: 'gutter integration marker', glyphMarginClassName: 'ash-gutter-probe' },
		}]);
		return { version: callerModel.getVersionId(), modelLineCount: callerModel.getLineCount() };
	},
	moveGutterCaret: (lineNumber, column) => callerEditor.setPosition(new stanza.Position(lineNumber, column)),
	shortenGutterLine: () => {
		callerEditor.executeEdits('gutter', [{ range: new stanza.Range(1, 1, 1, callerModel.getLineMaxColumn(1)), text: 'short' }]);
		return callerModel.getVersionId();
	},
	preparePointerSelection: () => {
		pointerMouseUpEvents = 0;
		callerEditor.setValue('alpha beta\nsecond line');
	},
	readPointerSelection: () => ({
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		selection: callerEditor.getSelection()?.toString() ?? null,
		ownedSelection: ownedEditor.getSelection()?.toString() ?? null,
		focused: callerEditor.hasTextFocus(),
		mouseUpEvents: pointerMouseUpEvents,
	}),
	prepareMultiCursor: () => {
		callerEditor.setValue('abcd\nefgh');
	},
	readMultiCursor: () => ({
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		selections: callerEditor.getSelections()?.map(selection => selection.toString()) ?? [],
		ownedSelections: ownedEditor.getSelections()?.map(selection => selection.toString()) ?? [],
		focused: callerEditor.hasTextFocus(),
	}),
	releaseCaller: () => {
		callerEditor.dispose();
		callerModel.setValue('changed after editor disposal');
	},
	releaseOwned: () => ownedEditor.dispose(),
	dispose: () => {
		contributionProviders.dispose();
		for (const request of contributionRequests) {
			request.finish(true);
		}
		languageRequestProviders.dispose();
		parameterHintsRegistration?.dispose();
		for (const request of parameterHintRequests) request.finish('empty');
		renameRegistration?.dispose();
		for (const request of renameRequests) request.finish('empty');
		for (const request of codeActionRequests) request.finish('disabled');
		inlayRegistration?.dispose();
		brokenInlayRegistration?.dispose();
		for (const request of inlayRequests) request.resolve([]);
		inlineBracketResources.dispose();
		inlineRegistration?.dispose();
		for (const request of inlineRequests) request.resolve();
		formattingProvider?.dispose();
		bracketTokenRegistration?.dispose();
		for (const request of deferredFormatting) request.resolve();
		referenceRegistration?.dispose();
		TokenizationRegistry.setColorMap([]);
		codeActionRegistration?.dispose();
		semanticRegistration?.dispose();
		completionRegistration?.dispose();
		ownedEditor.dispose();
		callerEditor.dispose();
		largeModel?.dispose();
		callerModel.dispose();
		pointerMouseUpListener.dispose();
		listener.dispose();
	},
};
