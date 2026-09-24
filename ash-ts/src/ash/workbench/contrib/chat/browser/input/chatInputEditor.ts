import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import "./chatInputEditor.css";
import { addDisposableListener, stopEvent, h } from "../../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { RunOnceScheduler } from "../../../../../base/common/async.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { EditorLineWrapping } from "../../../../../editor/common/config/editorOptions.js";
import { CodeEditorWidget } from "../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js";
import { EditorExtensionsRegistry, type EditorContributionRegistration } from "../../../../../editor/browser/editorExtensions.js";
import { LanguageCompletionService } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { LanguageCompletionProviderRegistry } from '../../../../../editor/common/languageFeatureRegistry.js';
import { SuggestModel } from "../../../../../editor/contrib/suggest/browser/suggestModel.js";
import { SuggestController } from "../../../../../editor/contrib/suggest/browser/suggestController.js";
import "../../../../../editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "../../../../../editor/browser/coreCommands.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { type ChatInputEditorOptions, type IChatInputEditor } from "./chatInputEditorRegistry.js";
import { CHAT_INPUT_LANGUAGE_ID, createChatCommandCompletionProvider } from "./chatCommandCompletion.js";
import { createChatSkillCompletionProvider } from "./chatSkillCompletion.js";

const CHAT_INPUT_LINE_HEIGHT = 20;
const CHAT_INPUT_EDITOR_PADDING = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const CHAT_INPUT_MIN_HEIGHT = 106;
const CHAT_INPUT_MAX_HEIGHT = 320;

/** Stanza-backed embedded editor hosted by the Chat input part. */
export class ChatInputEditor extends Disposable implements IChatInputEditor {
	readonly element: HTMLDivElement;
	private readonly model = this._register(new TextModel('', { languageId: CHAT_INPUT_LANGUAGE_ID }));
	private readonly editor: CodeEditorWidget;
	private readonly _onDidChange = this._register(new Emitter<string>());
	private readonly _onDidSubmit = this._register(new Emitter<void>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	readonly onDidSubmit: Event<void> = this._onDidSubmit.event;
	private height = CHAT_INPUT_MIN_HEIGHT;

	constructor(options: ChatInputEditorOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.element = h(options.container.ownerDocument, "div");
		this.element.className = "ash-chat-input-editor";
		this.element.style.height = `${this.height}px`;
		options.container.append(this.element);
		const providers = this._register(new LanguageCompletionProviderRegistry());
		this._register(providers.register(createChatCommandCompletionProvider(options.slashCommands)));
		this._register(providers.register(createChatSkillCompletionProvider(options.skills)));
		const chatSuggest = {
			id: SuggestController.ID,
			install: context => {
				if (context.kind !== 'text') return;
				const completions = context.register(new LanguageCompletionService(context.model, providers));
				const session = context.register(new SuggestModel(completions.results, context.editor, {
					resolver: completions,
				}));
				return new SuggestController(context.editor, context.controller, completions, session, {
					widgetContainer: this.element,
				});
			},
		} satisfies EditorContributionRegistration;
		const contributions = EditorExtensionsRegistry.getEditorContributions().map(contribution =>
			contribution.id === SuggestController.ID ? chatSuggest : contribution,
		);
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.element,
			model: this.model,
			lineHeight: CHAT_INPUT_LINE_HEIGHT,
			ariaLabel: options.ariaLabel,
			placeholder: options.placeholder,
			presentation: "embedded",
			padding: CHAT_INPUT_EDITOR_PADDING,
			lineWrapping: EditorLineWrapping.On,
			contributions,
		}));
		const layout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(this.model.onDidChangeContent(() => {
			layout.schedule();
			this._onDidChange.fire(this.value);
		}));
		this._register(addDisposableListener(this.editor.controller.element, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.key !== "Enter" || event.shiftKey) return;
			stopEvent(event);
			this._onDidSubmit.fire();
		}));
		this._register(toDisposable(() => this.element.remove()));
		const observer = new ResizeObserver(() => layout.schedule());
		this._register(toDisposable(() => observer.disconnect()));
		observer.observe(this.element);
		layout.schedule();
	}

	get value(): string {
		return this.model.getText();
	}

	set value(value: string) {
		if (this.model.getText() === value) return;
		const range = Range.fromPositions(new Position((0) + 1, (0) + 1), this.model.positionAt(this.model.length));
		this.model.applyEdits([{ range, text: value }]);
		this.editor.setPosition(this.model.positionAt(this.model.length));
	}

	focus(): void {
		this.editor.focus();
	}

	layout(): void {
		const width = this.element.clientWidth;
		if (width <= 0) return;
		this.editor.layout({ width, height: this.height });
		this.syncHeight();
	}

	private syncHeight(): void {
		if (this.element.clientWidth <= 0) return;
		const contentHeight = this.editor.getBottomForLineNumber(this.model.lineCount) + CHAT_INPUT_EDITOR_PADDING.bottom;
		const height = Math.min(CHAT_INPUT_MAX_HEIGHT, Math.max(CHAT_INPUT_MIN_HEIGHT, contentHeight));
		if (height === this.height) return;
		this.height = height;
		this.element.style.height = `${height}px`;
		this.layout();
	}
}
