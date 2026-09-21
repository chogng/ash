import { Position } from "../../../../common/core/position.js";
import "../media/inlineCompletions.css";
import { registerEditorContribution } from "../../../../browser/editorExtensions.js";
import { addDisposableListener, stopEvent, h } from "../../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { Range } from "../../../../common/core/range.js";
import { Selection } from '../../../../common/core/selection.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { IInlineCompletionsService } from '../../../../browser/services/inlineCompletionsService.js';
import { type LanguageInlineCompletionItem, type LanguageInlineCompletionsProvider } from "../../common/inlineCompletions.js";
import { type View } from "../../../../browser/view.js";
import { isCompletionsEnabledFromObject } from "../../../../common/services/completionsEnablement.js";
import { type Event } from '../../../../../base/common/event.js';
import { type EditorCommandEvent } from '../../../../browser/editorExtensions.js';
import { TriggerInlineEditCommandsRegistry } from '../../../../browser/triggerInlineEditCommandsRegistry.js';
import { type TextModel } from '../../../../common/model/textModel.js';
import { type LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { provideInlineCompletions } from '../model/provideInlineCompletions.js';
import { type TextEdit } from '../../../../common/languages.js';
import { type ICursorStateComputerData, type IEditOperationBuilder, type ICommand } from '../../../../common/editorCommon.js';
import { type ITextModel } from '../../../../common/model.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { ILanguageFeatureDebounceService, type IFeatureDebounceInformation } from '../../../../common/services/languageFeatureDebounce.js';
import { ILanguageConfigurationService } from '../../../../common/languages/languageConfigurationRegistry.js';

/** Owns ghost-text projection and explicit acceptance of one inline completion. */
export class InlineCompletionsController extends Disposable {
	private readonly element: HTMLSpanElement;
	private request: AbortController | undefined;
	private item: LanguageInlineCompletionItem | undefined;
	private completionRequestId = 0;
	private readonly debounce: IFeatureDebounceInformation;
	private readonly scheduler: RunOnceScheduler;
	private composing = false;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly model: TextModel,
		private readonly providers: LanguageFeatureRegistry<LanguageInlineCompletionsProvider>,
		onDidExecuteCommand: Event<EditorCommandEvent> | undefined,
		private readonly onError: (error: unknown) => void,
		@IInlineCompletionsService private readonly inlineCompletionsService: IInlineCompletionsService,
		@ILanguageFeatureDebounceService debounceService: ILanguageFeatureDebounceService,
		@ILanguageConfigurationService private readonly languageConfigurationService: ILanguageConfigurationService,
	) {
		super();
		if (editor.getModel() !== model || viewport.textModel !== model) throw new TypeError('Inline completion dependencies must share one text model');
		this.debounce = debounceService.for(providers, 'Inline completions', { min: 50, max: 500 });
		this.scheduler = this._register(new RunOnceScheduler(() => void this.refresh('automatic'), this.debounce.default()));
		const element = this.element = h(viewport.domNode.domNode.ownerDocument, "span");
		element.className = "stanza-editor-inline-completion";
		element.hidden = true;
		viewport.domNode.domNode.append(element);
		this._register(toDisposable(() => {
			this.clear();
			element.remove();
		}));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || !event.ctrlKey || !event.altKey || event.key !== " ") return;
			stopEvent(event);
			void this.refresh("explicit");
		}));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || !this.item || event.key !== "Enter" || !event.altKey) return;
			stopEvent(event);
			this.accept();
		}));
		this._register(inlineCompletionsService.onDidChangeIsSnoozing(snoozing => {
			if (snoozing) {
				this.clear();
			}
		}));
		this._register(editor.onDidChangeCursorSelection(() => this.clear()));
		this._register(editor.onDidType(() => this.schedule()));
		this._register(editor.onDidCompositionStart(() => {
			this.composing = true;
			this.clear();
		}));
		this._register(editor.onDidCompositionEnd(() => {
			this.composing = false;
			this.schedule();
		}));
		this._register(editor.onDidBlurEditorText(() => this.clear()));
		this._register(providers.onDidChange(() => this.clear()));
		this._register(model.onWillDispose(() => this.clear()));
		this._register(model.onDidChangeLanguage(() => this.clear()));
		this._register(viewport.onDidChangeLayout(() => this.render()));
		this._register(viewport.textModel.onDidChangeContent(() => this.clear()));
		if (onDidExecuteCommand) {
			const triggerCommands = new Set(TriggerInlineEditCommandsRegistry.getRegisteredCommands());
			this._register(onDidExecuteCommand(event => {
				if (!triggerCommands.has(event.commandId)) return;
				this.schedule();
			}));
		}
	}

	private schedule(): void {
		this.clear();
		if (this.isDisposed || this.model.isDisposed() || this.composing || this.inlineCompletionsService.isSnoozing() || !this.providers.has(this.model)) {
			return;
		}
		this.scheduler.schedule(this.debounce.get(this.model));
	}

	private async refresh(triggerKind: "automatic" | "explicit"): Promise<void> {
		this.clear();
		if (this.isDisposed || this.model.isDisposed() || this.composing || this.inlineCompletionsService.isSnoozing()) {
			return;
		}
		const selection = this.editor.getSelection();
		if (!selection) return;
		if (!selection.isEmpty()) return;
		const request = this.request = new AbortController();
		const duration = StopWatch.create();
		try {
			const items = await provideInlineCompletions(this.model, this.providers, this.model.getLanguageId(), selection.getPosition(), triggerKind, request.signal, this.languageConfigurationService);
			if (request.signal.aborted) return;
			this.debounce.update(this.model, duration.elapsed());
			this.item = items[0];
			if (this.item) this.inlineCompletionsService.reportNewCompletion(`editor-inline-${++this.completionRequestId}`);
			this.render();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		} finally {
			if (this.request === request) {
				this.request = undefined;
			}
		}
	}

	private render(): void {
		const item = this.item;
		if (!item) {
			this.element.hidden = true;
			return;
		}
		const selection = this.editor.getSelection();
		if (!selection) return;
		const range = item.range ?? Range.fromPositions(selection.getPosition());
		const coordinates = this.viewport.getPositionContentCoordinates(range.getStartPosition());
		const scroll = this.viewport.viewportLayout.scrollPosition;
		this.element.textContent = item.insertText;
		this.element.style.left = `${coordinates.left - scroll.left}px`;
		this.element.style.top = `${coordinates.top - scroll.top}px`;
		this.element.hidden = false;
	}

	private accept(): void {
		const item = this.item;
		if (!item) return;
		const selection = this.editor.getSelection();
		if (!selection) return;
		const mainEdit = { range: item.range ?? Range.fromPositions(selection.getPosition()), text: item.insertText };
		const edits = [...(item.additionalTextEdits ?? []), mainEdit].sort((left, right) => Position.compare(Range.lift(left.range).getStartPosition(), Range.lift(right.range).getStartPosition()));
		const command = new AcceptInlineCompletionCommand(edits, edits.indexOf(mainEdit));
		this.editor.pushUndoStop();
		this.editor.executeCommands('editor.action.inlineSuggest.commit', [command, ...(this.editor.getSelections() ?? []).slice(1).map(() => null)]);
		this.editor.pushUndoStop();
		this.clear();
	}

	private clear(): void {
		this.scheduler.cancel();
		this.request?.abort();
		this.request = undefined;
		this.item = undefined;
		this.element.hidden = true;
		this.element.textContent = "";
	}
}

class AcceptInlineCompletionCommand implements ICommand {
	constructor(private readonly edits: readonly TextEdit[], private readonly mainEditIndex: number) {}

	getEditOperations(_model: ITextModel, builder: IEditOperationBuilder): void {
		for (const edit of this.edits) builder.addTrackedEditOperation(edit.range, edit.text);
	}

	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return Selection.fromPositions(helper.getInverseEditOperations()[this.mainEditIndex]!.range.getEndPosition());
	}
}

registerEditorContribution({ id: "editor.contrib.inlineCompletions", install: context => {
	if (context.kind !== "text" || (context.options.inlineCompletions !== undefined && !isCompletionsEnabledFromObject(context.options.inlineCompletions, context.languageId))) return;
	return context.instantiationService.createInstance(InlineCompletionsController, context.controller.element, context.editor, context.view, context.model, context.languageFeaturesService.inlineCompletionsProvider, context.onDidExecuteCommand, context.onLanguageError);
} });
