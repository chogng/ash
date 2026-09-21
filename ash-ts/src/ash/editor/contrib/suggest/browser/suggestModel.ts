import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { EditorOption } from "../../../common/config/editorOptions.js";
import { type VersionedLanguageResult } from "../../../common/languages/languageRequestCoordinator.js";
import { type VersionedLanguageResultStore } from "../../../common/languages/languageResultStore.js";
import { assertLanguageCompletionCommitCharacter, normalizeLanguageCompletionItemDetails, LanguageCompletionInsertTextFormat, type LanguageCompletionItem, type LanguageCompletionItemDetails, type LanguageCompletionItemResolver, type LanguageCompletionResolveRequest, type LanguageCompletionResult } from '../../../common/languages.js';

import { parseSnippet, type Snippet, type SnippetVariableResolver } from "../../snippet/common/snippetParser.js";
import { SnippetSession } from "../../snippet/browser/snippetSession.js";
import { Position } from "../../../common/core/position.js";
import { Selection } from "../../../common/core/selection.js";
import { normalizeTextLineEndings } from "../../../common/core/textChange.js";
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from "../../../common/editorCommon.js";
import { type ITextModel } from "../../../common/model.js";
import { type TextModel } from "../../../common/model/textModel.js";

export enum LanguageCompletionSessionChangeReason {
	Store = "store",
	Focus = "focus",
	Selection = "selection",
	Cancelled = "cancelled",
	Accepted = "accepted",
	Details = "details",
}

export enum LanguageCompletionDetailsStatus {
	Complete = "complete",
	Loading = "loading",
	Failed = "failed",
	Unavailable = "unavailable",
}

export interface LanguageCompletionSessionState {
	readonly requestId: number;
	readonly modelVersion: number;
	readonly position: Position;
	readonly items: readonly LanguageCompletionItem[];
	readonly selectedIndex: number;
	readonly selectedItem: LanguageCompletionItem;
	readonly isIncomplete: boolean;
	readonly detailsStatus: LanguageCompletionDetailsStatus;
	readonly details: LanguageCompletionItemDetails;
}

export interface LanguageCompletionSessionChange {
	readonly reason: LanguageCompletionSessionChangeReason;
	readonly state: LanguageCompletionSessionState | undefined;
}

export interface LanguageCompletionSessionOptions {
	readonly resolver?: LanguageCompletionItemResolver;
	readonly onResolveError?: (error: unknown) => void;
	readonly onDidAccept?: (item: LanguageCompletionItem) => void | Promise<void>;
	/** Editor-context variables made available to accepted completion snippets. */
	readonly snippetVariables?: SnippetVariableResolver;
}

/**
 * Owns one editor instance's completion focus and acceptance lifecycle.
 *
 * The controller observes but does not own its result store, editor, or text model.
 */
export class SuggestModel extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<LanguageCompletionSessionChange>());
	private currentState: LanguageCompletionSessionState | undefined;
	private readonly resolver: LanguageCompletionItemResolver | undefined;
	private readonly onResolveError: (error: unknown) => void;
	private readonly onDidAccept: ((item: LanguageCompletionItem) => void | Promise<void>) | undefined;
	private readonly snippetVariables: SnippetVariableResolver | undefined;
	private resolveController: AbortController | undefined;
	private snippetSession: SnippetSession | undefined;
	private accepting = false;

	readonly onDidChange: Event<LanguageCompletionSessionChange> = this.changeEmitter.event;

	constructor(
		private readonly store: VersionedLanguageResultStore<LanguageCompletionResult>,
		private readonly editor: ICodeEditor,
		options: LanguageCompletionSessionOptions = {},
	) {
		super();
		try {
			if (store.textModel !== editor.getModel()) {
				throw new TypeError("Language completion store and editor must share one text model");
			}
			if (options.resolver !== undefined && typeof options.resolver.resolveCompletionItem !== "function") {
				throw new TypeError("Language completion session resolver must implement resolveCompletionItem");
			}
			if (options.onResolveError !== undefined && typeof options.onResolveError !== "function") {
				throw new TypeError("Language completion resolve error handler must be a function");
			}
			if (options.onDidAccept !== undefined && typeof options.onDidAccept !== "function") throw new TypeError("Language completion accept handler must be a function");
			if (options.snippetVariables !== undefined && typeof options.snippetVariables.resolveVariable !== "function") {
				throw new TypeError("Language completion snippet variables require a resolver");
			}
			this.resolver = options.resolver;
			this.onResolveError = options.onResolveError ?? reportResolveError;
			this.onDidAccept = options.onDidAccept;
			this.snippetVariables = options.snippetVariables;
			this.currentState = this.createState(store.result);
			this._register(store.onDidChange(change => {
				if (!this.accepting) this.replaceState(change.result, LanguageCompletionSessionChangeReason.Store);
			}));
			this._register(editor.onDidChangeCursorSelection(() => {
				if (!this.accepting) this.close(LanguageCompletionSessionChangeReason.Selection);
			}));
			this._register(editor.onDidChangeModel(() => {
				if (editor.getModel() !== store.textModel) {
					this.dispose();
				}
			}));
			this._register(editor.onDidDispose(() => this.dispose()));
			this._register(toDisposable(() => {
				this.cancelResolution("sessionDisposed");
				this.snippetSession?.dispose();
				this.snippetSession = undefined;
				const hadState = this.currentState !== undefined;
				this.currentState = undefined;
				if (hadState) this.fire(LanguageCompletionSessionChangeReason.Cancelled);
			}));
			this.startResolution();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	get textModel(): TextModel {
		this.assertNotDisposed();
		return this.store.textModel;
	}

	get resultStore(): VersionedLanguageResultStore<LanguageCompletionResult> {
		this.assertNotDisposed();
		return this.store;
	}

	get state(): LanguageCompletionSessionState | undefined {
		this.assertNotDisposed();
		return this.currentState;
	}

	selectNext(): boolean {
		return this.selectRelative(1);
	}

	selectPrevious(): boolean {
		return this.selectRelative(-1);
	}

	selectIndex(index: number): boolean {
		this.assertNotDisposed();
		const state = this.currentState;
		if (!state) return false;
		if (!Number.isSafeInteger(index) || index < 0 || index >= state.items.length) {
			throw new RangeError(`Completion selection index must be between 0 and ${state.items.length - 1}`);
		}
		if (index === state.selectedIndex) return true;
		this.cancelResolution("selectionChanged");
		this.currentState = createStateSnapshot(state, index, this.resolver !== undefined);
		this.fire(LanguageCompletionSessionChangeReason.Focus);
		this.startResolution();
		return true;
	}

	cancel(): boolean {
		this.assertNotDisposed();
		return this.close(LanguageCompletionSessionChangeReason.Cancelled);
	}

	acceptSelected(): boolean {
		return this.acceptSelectedWithCommitCharacter();
	}

	/** Accepts the focused item and writes its declared commit character in the same undo step. */
	acceptSelectedWithCommitCharacter(commitCharacter?: string): boolean {
		this.assertNotDisposed();
		const state = this.currentState;
		if (!state || !this.selectionMatches(state.position) || this.editor.getOption(EditorOption.readOnly)) return false;
		if (commitCharacter !== undefined) {
			assertLanguageCompletionCommitCharacter(commitCharacter);
			if (!state.selectedItem.commitCharacters?.includes(commitCharacter)) return false;
		}
		const insertion = resolveLanguageCompletionInsertion(state.selectedItem, commitCharacter, this.textModel, this.snippetVariables);
		const command = createLanguageCompletionAcceptCommand(
			this.textModel,
			this.editor,
			state.selectedItem,
			commitCharacter,
			this.snippetVariables,
		);
		this.accepting = true;
		try {
			this.editor.pushUndoStop();
			this.editor.executeCommand("suggest.accept", command);
			this.editor.pushUndoStop();
			if (insertion.snippet && insertion.snippet.placeholderGroups.length > 0) {
				this.snippetSession?.dispose();
				this.snippetSession = new SnippetSession(
					this.textModel,
					this.editor,
					insertion.resultStartOffset,
					insertion.snippet,
					insertion.text.length,
				);
			}
		} catch (error) {
			this.accepting = false;
			this.replaceState(this.store.result, LanguageCompletionSessionChangeReason.Store);
			throw error;
		}
		this.accepting = false;
		if (state.selectedItem.command && this.onDidAccept) void Promise.resolve().then(() => this.onDidAccept!(state.selectedItem)).catch(this.onResolveError);
		this.close(LanguageCompletionSessionChangeReason.Accepted);
		return true;
	}

	/** Advances an active accepted-snippet tabstop sequence, if any. */
	selectNextSnippetPlaceholder(): boolean {
		this.assertNotDisposed();
		const session = this.snippetSession;
		if (!session) return false;
		const handled = session.selectNext();
		if (session.isDisposed) this.snippetSession = undefined;
		return handled;
	}

	/** Moves backwards through an active accepted-snippet tabstop sequence. */
	selectPreviousSnippetPlaceholder(): boolean {
		this.assertNotDisposed();
		const session = this.snippetSession;
		if (!session) return false;
		return session.selectPrevious();
	}

	/** Selects the next value of the active accepted-snippet choice tabstop. */
	selectNextSnippetChoice(): boolean {
		this.assertNotDisposed();
		return this.snippetSession?.selectNextChoice() ?? false;
	}

	/** Selects the previous value of the active accepted-snippet choice tabstop. */
	selectPreviousSnippetChoice(): boolean {
		this.assertNotDisposed();
		return this.snippetSession?.selectPreviousChoice() ?? false;
	}

	/** Stops tabstop navigation while preserving the expanded snippet text. */
	cancelSnippetPlaceholderNavigation(): boolean {
		this.assertNotDisposed();
		if (!this.snippetSession) return false;
		this.snippetSession.dispose();
		this.snippetSession = undefined;
		return true;
	}

	private selectRelative(delta: number): boolean {
		this.assertNotDisposed();
		const state = this.currentState;
		if (!state) return false;
		return this.selectIndex(rot(state.selectedIndex + delta, state.items.length));
	}

	private replaceState(result: VersionedLanguageResult<LanguageCompletionResult> | undefined, reason: LanguageCompletionSessionChangeReason): void {
		const next = this.createState(result);
		if (statesEqual(this.currentState, next)) return;
		this.cancelResolution("completionResultChanged");
		this.currentState = next;
		this.fire(reason);
		this.startResolution();
	}

	private createState(result: VersionedLanguageResult<LanguageCompletionResult> | undefined): LanguageCompletionSessionState | undefined {
		if (!result || result.value.items.length === 0 || !this.selectionMatches(result.value.position)) {
			return undefined;
		}
		const previousItem = this.currentState?.selectedItem;
		const retainedIndex = previousItem === undefined
			? -1
			: result.value.items.findIndex(item => (
				item.providerId === previousItem.providerId &&
				item.id === previousItem.id
			));
		const preselectedIndex = result.value.items.findIndex(item => item.preselect === true);
		const selectedIndex = retainedIndex >= 0
			? retainedIndex
			: Math.max(0, preselectedIndex);
		return Object.freeze({
			requestId: result.requestId,
			modelVersion: result.modelVersion,
			position: result.value.position,
			items: result.value.items,
			selectedIndex,
			selectedItem: result.value.items[selectedIndex]!,
			isIncomplete: result.value.isIncomplete,
			...createDetailsState(result.value.items[selectedIndex]!, this.resolver !== undefined),
		});
	}

	private selectionMatches(position: Position): boolean {
		if (this.editor.getModel() !== this.store.textModel) return false;
		const selections = this.editor.getSelections();
		return selections?.length === 1 &&
			selections[0]!.isEmpty() &&
			Position.compare(selections[0]!.getPosition(), position) === 0;
	}

	private close(reason: LanguageCompletionSessionChangeReason): boolean {
		if (!this.currentState) return false;
		this.cancelResolution("sessionClosed");
		this.currentState = undefined;
		this.fire(reason);
		return true;
	}

	private fire(reason: LanguageCompletionSessionChangeReason): void {
		this.changeEmitter.fire(Object.freeze({
			reason,
			state: this.currentState,
		}));
	}

	private startResolution(): void {
		const state = this.currentState;
		if (!state || state.detailsStatus !== LanguageCompletionDetailsStatus.Loading || !this.resolver) return;
		const controller = new AbortController();
		this.resolveController = controller;
		const request = createResolveRequest(state);
		void Promise.resolve().then(() => this.resolver!.resolveCompletionItem(request, controller.signal)).then(details => {
			if (controller.signal.aborted || this.currentState !== state) return;
			this.resolveController = undefined;
			this.currentState = Object.freeze({
				...state,
				detailsStatus: LanguageCompletionDetailsStatus.Complete,
				details: mergeDetails(state.selectedItem, normalizeLanguageCompletionItemDetails(details)),
			});
			this.fire(LanguageCompletionSessionChangeReason.Details);
		}, error => {
			if (controller.signal.aborted || this.currentState !== state) return;
			this.resolveController = undefined;
			this.currentState = Object.freeze({
				...state,
				detailsStatus: LanguageCompletionDetailsStatus.Failed,
			});
			this.fire(LanguageCompletionSessionChangeReason.Details);
			try {
				this.onResolveError(error);
			} catch (reportingError) {
				reportResolveError(new AggregateError([error, reportingError], "Completion resolution and error reporting both failed"));
			}
		});
	}

	private cancelResolution(reason: string): void {
		this.resolveController?.abort(reason);
		this.resolveController = undefined;
	}
}

function createLanguageCompletionAcceptCommand(model: TextModel, editor: ICodeEditor, item: LanguageCompletionItem, commitCharacter?: string, snippetVariables?: SnippetVariableResolver): ICommand {
	if (model !== editor.getModel()) {
		throw new TypeError("Language completion command and editor must share one text model");
	}
	const selections = editor.getSelections();
	if (selections?.length !== 1 || !selections[0]!.isEmpty()) {
		throw new Error("Language completion acceptance requires one collapsed selection");
	}
	const position = selections[0]!.getPosition();
	if (Position.compare(item.range.getStartPosition(), position) > 0 || Position.compare(item.range.getEndPosition(), position) < 0) {
		throw new RangeError("Language completion item range must contain the active position");
	}
	if (commitCharacter !== undefined) {
		assertLanguageCompletionCommitCharacter(commitCharacter);
		if (!item.commitCharacters?.includes(commitCharacter)) {
			throw new RangeError("Language completion item does not declare this commit character");
		}
	}
	const insertion = resolveLanguageCompletionInsertion(item, commitCharacter, model, snippetVariables);
	return new LanguageCompletionAcceptCommand(item.range, insertion.text, item.additionalTextEdits ?? []);
}

class LanguageCompletionAcceptCommand implements ICommand {
	private readonly edits: readonly { readonly range: import("../../../common/core/range.js").Range; readonly text: string }[];
	private readonly primaryEditIndex: number;

	constructor(primaryRange: import("../../../common/core/range.js").Range, text: string, additionalEdits: readonly { readonly range: import("../../../common/core/range.js").Range; readonly text: string }[]) {
		const primaryEdit = { range: primaryRange, text };
		this.edits = [primaryEdit, ...additionalEdits].sort((left, right) => {
			const start = Position.compare(left.range.getStartPosition(), right.range.getStartPosition());
			return start || Position.compare(left.range.getEndPosition(), right.range.getEndPosition());
		});
		this.primaryEditIndex = this.edits.indexOf(primaryEdit);
	}

	getEditOperations(_model: ITextModel, builder: IEditOperationBuilder): void {
		for (const edit of this.edits) builder.addTrackedEditOperation(edit.range, edit.text);
	}

	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		const primaryInverseEdit = helper.getInverseEditOperations()[this.primaryEditIndex];
		if (!primaryInverseEdit) throw new Error("Language completion primary edit was not applied");
		return Selection.fromPositions(primaryInverseEdit.range.getEndPosition());
	}
}

interface LanguageCompletionInsertion {
	readonly text: string;
	readonly snippet: Snippet | undefined;
	readonly resultStartOffset: number;
}

function resolveLanguageCompletionInsertion(item: LanguageCompletionItem, commitCharacter: string | undefined, model?: TextModel, snippetVariables?: SnippetVariableResolver): LanguageCompletionInsertion {
	const snippet = item.insertTextFormat === LanguageCompletionInsertTextFormat.Snippet
		? parseSnippet(normalizeTextLineEndings(item.insertText), { variables: snippetVariables })
		: undefined;
	const text = (snippet?.text ?? normalizeTextLineEndings(item.insertText)) + (commitCharacter ?? "");
	const primaryStartOffset = model?.offsetAt(item.range.getStartPosition()) ?? 0;
	const offsetDelta = model
		? (item.additionalTextEdits ?? []).reduce((delta, edit) => Position.compare(edit.range.getEndPosition(), item.range.getStartPosition()) < 0
			? delta + edit.text.length - (model.offsetAt(edit.range.getEndPosition()) - model.offsetAt(edit.range.getStartPosition()))
			: delta, 0)
		: 0;
	return Object.freeze({ text, snippet, resultStartOffset: primaryStartOffset + offsetDelta });
}

function createStateSnapshot(state: LanguageCompletionSessionState, selectedIndex: number, resolverAvailable: boolean): LanguageCompletionSessionState {
	const selectedItem = state.items[selectedIndex]!;
	return Object.freeze({
		...state,
		selectedIndex,
		selectedItem,
		...createDetailsState(selectedItem, resolverAvailable),
	});
}

function createDetailsState(item: LanguageCompletionItem, resolverAvailable: boolean): Pick<LanguageCompletionSessionState, "details" | "detailsStatus"> {
	return Object.freeze({
		details: mergeDetails(item, undefined),
		detailsStatus: item.hasDeferredDetails
			? resolverAvailable
				? LanguageCompletionDetailsStatus.Loading
				: LanguageCompletionDetailsStatus.Unavailable
			: LanguageCompletionDetailsStatus.Complete,
	});
}

function mergeDetails(item: LanguageCompletionItem, resolved: LanguageCompletionItemDetails | undefined): LanguageCompletionItemDetails {
	return normalizeLanguageCompletionItemDetails({
		...(resolved?.detail === undefined && item.detail === undefined ? {} : { detail: resolved?.detail ?? item.detail }),
		...(resolved?.documentation === undefined && item.documentation === undefined ? {} : { documentation: resolved?.documentation ?? item.documentation }),
	});
}

function createResolveRequest(state: LanguageCompletionSessionState): LanguageCompletionResolveRequest {
	return Object.freeze({
		completionRequestId: state.requestId,
		modelVersion: state.modelVersion,
		providerId: state.selectedItem.providerId,
		itemId: state.selectedItem.id,
	});
}

function statesEqual(left: LanguageCompletionSessionState | undefined, right: LanguageCompletionSessionState | undefined): boolean {
	return left === right || (
		left !== undefined &&
		right !== undefined &&
		left.requestId === right.requestId &&
		left.selectedIndex === right.selectedIndex
	);
}

function reportResolveError(error: unknown): void {
	console.error("Language completion item resolution failed", error);
}
