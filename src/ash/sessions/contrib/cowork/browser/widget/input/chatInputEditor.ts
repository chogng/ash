import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import "./chatInputEditor.css";
import { addDisposableListener, stopEvent, h } from "../../../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../../../base/common/event.js";
import { RunOnceScheduler } from "../../../../../../base/common/async.js";
import { Disposable, toDisposable } from "../../../../../../base/common/lifecycle.js";
import { EditorLineWrapping } from "../../../../../../editor/common/config/editorOptions.js";
import { CodeEditorWidget } from "../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js";
import "../../../../../../editor/browser/coreCommands.js";
import { Position } from "../../../../../../editor/common/core/position.js";
import { Range } from "../../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../../editor/common/model/textModel.js";
import { type ChatInputEditorOptions, type IChatInputEditor } from "./chatInputEditorTypes.js";
import { CHAT_INPUT_LANGUAGE_ID, createChatCommandCompletionProvider } from "./chatCommandCompletion.js";
import { createChatSkillCompletionProvider } from "../../../../../../workbench/contrib/chat/browser/widget/input/editor/chatInputCompletions.js";

const CHAT_INPUT_LINE_HEIGHT = 20;
const CHAT_INPUT_EDITOR_PADDING = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
// The input container supplies the 6px top inset; editor heights exclude it to keep the composer height stable.
const CHAT_INPUT_MIN_HEIGHT = 100;
const CHAT_INPUT_MAX_HEIGHT = 314;

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
	private readonly minimumHeight: number;
	private readonly maximumHeight: number;

	constructor(options: ChatInputEditorOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.minimumHeight = options.height?.minimum ?? CHAT_INPUT_MIN_HEIGHT;
		this.maximumHeight = options.height?.maximum ?? CHAT_INPUT_MAX_HEIGHT;
		this.height = this.minimumHeight;
		this.element = h(options.container.ownerDocument, "div");
		this.element.className = "ash-cowork-input-editor";
		this.element.style.height = `${this.height}px`;
		this.element.style.minHeight = `${this.minimumHeight}px`;
		options.container.append(this.element);
		const completionProviders = [
			createChatCommandCompletionProvider(options.slashCommands),
			createChatSkillCompletionProvider(options.skills, { id: 'ash.cowork.skills', languageId: CHAT_INPUT_LANGUAGE_ID }),
		];
		// Chat only needs its placeholder and command/skill suggestions; unrelated editor features add work to every Chat tab.
		const contributionIds = ['editor.contrib.placeholderText', 'editor.contrib.suggestController'];
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.element,
			model: this.model,
			lineHeight: CHAT_INPUT_LINE_HEIGHT,
			ariaLabel: options.ariaLabel,
			placeholder: options.placeholder,
			presentation: "embedded",
			padding: CHAT_INPUT_EDITOR_PADDING,
			glyphMargin: false,
			lineDecorationsWidth: 0,
			folding: false,
			overviewRulerLanes: 0,
			scrollBeyondLastLine: false,
			lineWrapping: EditorLineWrapping.On,
			contributionIds,
			completionProviders,
			completionWidgetContainer: this.element,
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

	public insertText(text: string): void {
		const selection = this.editor.getSelection()!;
		const before = this.value.slice(0, this.model.offsetAt(selection.getStartPosition()));
		const separator = /[A-Za-z0-9]$/u.test(before) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		this.editor.pushUndoStop();
		this.editor.executeEdits('dictation', [{ range: selection, text: separator + text }]);
		this.editor.pushUndoStop();
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
		const height = Math.min(this.maximumHeight, Math.max(this.minimumHeight, contentHeight));
		if (height === this.height) return;
		this.height = height;
		this.element.style.height = `${height}px`;
		this.layout();
	}
}
