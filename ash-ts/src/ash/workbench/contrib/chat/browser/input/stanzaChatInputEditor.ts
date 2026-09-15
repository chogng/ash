import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import "./stanzaChatInputEditor.css";
import { addDisposableListener, stopEvent, h } from "../../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { EditorLineWrapping } from "../../../../../editor/common/config/editorOptions.js";
import { CodeEditorWidget } from "../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js";
import { CursorsController } from "../../../../../editor/common/cursor/cursor.js";
import { LanguageCompletionService } from "../../../../../editor/common/languages/completion/languageCompletionService.js";
import { LanguageCompletionProviderRegistry } from "../../../../../editor/common/languages/completion/languageCompletionProviders.js";
import { LanguageCompletionSessionController } from "../../../../../editor/contrib/suggest/common/languageCompletionSessionController.js";
import { SuggestController } from "../../../../../editor/contrib/suggest/browser/suggestController.js";
import "../../../../../editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import { Selection } from "../../../../../editor/common/core/selection.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { type ChatInputEditorOptions, type IChatInputEditor } from "./chatInputEditor.js";
import { CHAT_INPUT_LANGUAGE_ID, createStanzaChatCommandCompletionProvider } from "./stanzaChatCommandCompletion.js";
import { createStanzaChatSkillCompletionProvider } from "./stanzaChatSkillCompletion.js";

const CHAT_INPUT_LINE_HEIGHT = 20;
const CHAT_INPUT_EDITOR_PADDING = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const CHAT_INPUT_MIN_HEIGHT = 106;
const CHAT_INPUT_MAX_HEIGHT = 320;

/** Stanza-backed embedded editor hosted by the Chat input part. */
export class ChatInputEditor extends Disposable implements IChatInputEditor {
	readonly element: HTMLDivElement;
	private readonly model = this._register(new TextModel());
	private readonly selections: CursorsController;
	private readonly editor: CodeEditorWidget;
	private readonly _onDidChange = this._register(new Emitter<string>());
	private readonly _onDidSubmit = this._register(new Emitter<void>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	readonly onDidSubmit: Event<void> = this._onDidSubmit.event;
	private height = CHAT_INPUT_MIN_HEIGHT;
	private closed = false;

	constructor(options: ChatInputEditorOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.element = h(options.container.ownerDocument, "div");
		this.element.className = "ash-chat-input-editor";
		this.element.style.height = `${this.height}px`;
		options.container.append(this.element);
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.element,
			model: this.model,
			input: { resource: this.model.uri },
			languageId: CHAT_INPUT_LANGUAGE_ID,
			lineHeight: CHAT_INPUT_LINE_HEIGHT,
			ariaLabel: options.ariaLabel,
			placeholder: options.placeholder,
			presentation: "embedded",
			padding: CHAT_INPUT_EDITOR_PADDING,
			lineWrapping: EditorLineWrapping.On,
		}));
		this.selections = this.editor.selections;
		const providers = this._register(new LanguageCompletionProviderRegistry());
		this._register(providers.register(createStanzaChatCommandCompletionProvider(options.slashCommands)));
		this._register(providers.register(createStanzaChatSkillCompletionProvider(options.skills)));
		const completions = this._register(new LanguageCompletionService(this.model, providers));
		const completionSession = this._register(new LanguageCompletionSessionController(completions.results, this.selections, { resolver: completions }));
		this._register(new SuggestController(
			this.editor.controller,
			this.selections,
			completions,
			completionSession,
			CHAT_INPUT_LANGUAGE_ID,
			{ widgetContainer: this.element },
		));
		this._register(this.model.onDidChangeContent(() => {
			this.syncHeight();
			this._onDidChange.fire(this.value);
		}));
		this._register(addDisposableListener(this.editor.controller.element, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.key !== "Enter" || event.shiftKey) return;
			stopEvent(event);
			this._onDidSubmit.fire();
		}));
		this._register(toDisposable(() => this.closed = true));
		this._register(toDisposable(() => this.element.remove()));
		queueMicrotask(() => {
			if (!this.closed) this.layout();
		});
	}

	get value(): string {
		return this.model.getText();
	}

	set value(value: string) {
		if (this.model.getText() === value) return;
		const range = Range.fromPositions(new Position((0) + 1, (0) + 1), this.model.positionAt(this.model.length));
		this.model.applyEdits([{ range, text: value }]);
		const end = this.model.positionAt(this.model.length);
		this.selections.setSelections([Selection.fromPositions(end)]);
	}

	focus(): void {
		this.editor.focus();
	}

	layout(): void {
		this.editor.layout({ width: Math.max(0, this.element.clientWidth), height: this.height });
	}

	private syncHeight(): void {
		const contentHeight = this.model.lineCount * CHAT_INPUT_LINE_HEIGHT + CHAT_INPUT_EDITOR_PADDING.top + CHAT_INPUT_EDITOR_PADDING.bottom;
		const height = Math.min(CHAT_INPUT_MAX_HEIGHT, Math.max(CHAT_INPUT_MIN_HEIGHT, contentHeight));
		if (height === this.height) return;
		this.height = height;
		this.element.style.height = `${height}px`;
		this.layout();
	}
}
