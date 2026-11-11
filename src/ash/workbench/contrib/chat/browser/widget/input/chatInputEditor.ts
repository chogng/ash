import { Selection } from '../../../../../../editor/common/core/selection.js';
import type { ChatInputEditorSelection } from './chatInputEditorRegistry.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { getChatInputEditorFont } from '../chatOptions.js';
import './chatInputEditor.css';
import './editor/chatInputEditorContrib.js';
import './editor/chatInputEditorHover.js';
import { ChatInlineAttachments } from './editor/chatInlineAttachments.js';
import { addDisposableListener, stopEvent, h } from '../../../../../../base/browser/dom.js';
import { Emitter, type Event } from '../../../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { EditorLineWrapping, EditorOption } from '../../../../../../editor/common/config/editorOptions.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ChatInputConfiguration } from '../../../common/constants.js';
import { EditorCoreCommandId } from '../../../../../../editor/browser/coreCommands.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { LineInjectedText } from '../../../../../../editor/common/textModelEvents.js';
import { CHAT_INPUT_DEFAULT_MAX_HEIGHT, type ChatInputEditorOptions, type IChatInputEditor } from './chatInputEditorRegistry.js';
import { CHAT_INPUT_LANGUAGE_ID, createChatCommandCompletionProvider, createChatSkillCompletionProvider } from './editor/chatInputCompletions.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';
import { InputEditorCommandArgumentHint } from './editor/chatInputCommandArgumentHint.js';
import { LinkDetector } from '../../../../../../editor/contrib/links/browser/links.js';
import { CopyPasteController } from '../../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { PlaceholderTextContribution } from '../../../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import { EditorContributionInstantiation } from '../../../../../../editor/browser/editorExtensions.js';
import '../../../../../../editor/contrib/placeholderText/browser/placeholderText.css';

const CHAT_INPUT_EDITOR_PADDING = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const CHAT_INPUT_CARET_INSET = 2;
const CHAT_INPUT_SCROLLBAR_WIDTH = 8;
// The input container owns the inset; editor heights exclude it to avoid applying it twice.
const CHAT_INPUT_MIN_HEIGHT = 40;

/** Stanza-backed embedded editor hosted by the Chat input part. */
export class ChatInputEditor extends Disposable implements IChatInputEditor {
	readonly element: HTMLDivElement;
	private readonly model = this._register(new TextModel('', { languageId: CHAT_INPUT_LANGUAGE_ID }));
	private readonly editor: CodeEditorWidget;
	private readonly verticalScrollbarSize: number;
	private scrollbarInset = 0;
	public get codeEditor(): CodeEditorWidget { return this.editor; }
	private readonly _onDidChange = this._register(new Emitter<string>());
	private readonly _onDidSubmit = this._register(new Emitter<void>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	readonly onDidSubmit: Event<void> = this._onDidSubmit.event;
	private height = CHAT_INPUT_MIN_HEIGHT;
	private readonly minimumHeight: number;
	private readonly maximumHeight: number;
	private readonly defaultPlaceholder: string;
	private readonly tabFocusMode: boolean;
	private readonly inlineAttachments: ChatInlineAttachments;

	constructor(
		options: ChatInputEditorOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.minimumHeight = options.height?.minimum ?? CHAT_INPUT_MIN_HEIGHT;
		this.maximumHeight = options.height?.maximum ?? CHAT_INPUT_DEFAULT_MAX_HEIGHT;
		this.defaultPlaceholder = options.placeholder;
		this.tabFocusMode = options.tabFocusMode ?? false;
		this.height = this.minimumHeight;
		this.element = h(options.container.ownerDocument, 'div');
		this.element.className = 'ash-chat-input-editor';
		this.element.style.height = `${this.height}px`;
		this.element.style.minHeight = `${this.minimumHeight}px`;
		options.container.append(this.element);
		const completionProviders = [
			...(options.slashCommands ? [createChatCommandCompletionProvider(options.slashCommands, options.hostCompletions)] : []),
			...(!options.hostCompletions && options.skills ? [createChatSkillCompletionProvider(options.skills)] : []),
		];
		// Keep basic text commands alongside Chat features; unrelated editor features add work to every Chat tab.
		const contributionIds = [EditorCoreCommandId.selectAll, 'editor.contrib.codeServices', 'editor.contrib.suggestController', 'editor.contrib.hover', CopyPasteController.ID, LinkDetector.ID, 'chatTokenDeleter'];
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.element,
			model: this.model,
			...this.getFontOptions(),
			ariaLabel: options.ariaLabel,
			placeholder: options.placeholder,
			presentation: 'embedded',
			padding: CHAT_INPUT_EDITOR_PADDING,
			glyphMargin: false,
			lineDecorationsWidth: 0,
			folding: false,
			overviewRulerLanes: 0,
			scrollBeyondLastLine: false,
			revealHorizontalRightPadding: CHAT_INPUT_CARET_INSET,
			lineWrapping: EditorLineWrapping.On,
			wrappingStrategy: 'advanced',
			tabFocusMode: this.tabFocusMode,
			contributionIds,
			// Plain-text hosts do not activate the full editor feature package.
			contributions: [{ id: PlaceholderTextContribution.ID, ctor: PlaceholderTextContribution, instantiation: EditorContributionInstantiation.Eager }],
			completionProviders,
			completionWidgetContainer: this.element,
		}));
		this.verticalScrollbarSize = this.editor.getOption(EditorOption.scrollbar).verticalScrollbarSize;
		if (options.ariaDescribedBy) {
			const { textArea, element } = this.editor.controller;
			(textArea ?? element).setAttribute('aria-describedby', options.ariaDescribedBy);
		}
		this.inlineAttachments = this._register(instantiationService.createInstance(ChatInlineAttachments, this.editor, options.imageAnnotationTarget));
		if (options.slashCommands) { this._register(new InputEditorCommandArgumentHint(this.editor, options.slashCommands)); }
		const layout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (!Object.values(ChatInputConfiguration).some(key => event.affectsConfiguration(key))) return;
			this.editor.updateOptions(this.getFontOptions());
			layout.schedule();
		}));
		this._register(this.model.onDidChangeContent(() => {
			layout.schedule();
			this._onDidChange.fire(this.value);
		}));
		this._register(addDisposableListener(this.editor.controller.element, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || event.shiftKey
				|| (options.submitWithModifier && !event.ctrlKey && !event.metaKey)) return;
			if (event.altKey && !event.ctrlKey && !event.metaKey) {
				stopEvent(event);
				this.inlineAttachments.openActivePill();
				return;
			}
			if (this.editor.getOption(EditorOption.readOnly)) return;
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

	getModel(): TextModel {
		return this.model;
	}

	renderContextReferences(references: readonly ChatContextAttachment[], remove: (id: string) => void): void {
		this.inlineAttachments.refresh(references, remove);
		this.editor.updateOptions({ ...this.getFontOptions(), tabFocusMode: this.tabFocusMode || this.inlineAttachments.getPillReferences().length > 0 });
		this.layout();
	}

	set value(value: string) {
		if (this.model.getText() === value) return;
		const range = Range.fromPositions(new Position((0) + 1, (0) + 1), this.model.positionAt(this.model.length));
		this.model.applyEdits([{ range, text: value }]);
		this.editor.setPosition(this.model.positionAt(this.model.length));
	}

	getSelection(): ChatInputEditorSelection {
		const selection = this.editor.getSelection()!;
		return {
			anchor: this.model.offsetAt(new Position(selection.selectionStartLineNumber, selection.selectionStartColumn)),
			active: this.model.offsetAt(selection.getPosition()),
		};
	}

	setSelection(selection: ChatInputEditorSelection): void {
		const anchor = this.model.positionAt(selection.anchor);
		const active = this.model.positionAt(selection.active);
		this.editor.setSelection(new Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column));
	}

	isAtHistoryBoundary(direction: 'previous' | 'next'): boolean {
		if (!this.editor.getSelection()?.isEmpty()) return false;
		const position = this.editor.getPosition();
		if (!position) return false;
		const top = this.editor.getTopForPosition(position.lineNumber, position.column);
		return direction === 'previous' ? top === this.editor.getTopForPosition(1, 1)
			: top === this.editor.getTopForPosition(this.model.lineCount, this.model.getLineLength(this.model.lineCount) + 1);
	}

	focus(): void {
		this.editor.focus();
	}

	setReadOnly(readOnly: boolean): void {
		if (this.editor.getOption(EditorOption.readOnly) === readOnly) return;
		this.editor.updateOptions({ readOnly });
		this.editor.controller.element.setAttribute('aria-disabled', String(readOnly));
	}

	setPlaceholder(placeholder = this.defaultPlaceholder): void {
		if (this.editor.getOption(EditorOption.placeholder) !== placeholder) this.editor.updateOptions({ placeholder });
	}

	public insertText(text: string): void {
		const selection = this.editor.getSelection()!;
		const before = this.value.slice(0, this.model.offsetAt(selection.getStartPosition()));
		const separator = /[A-Za-z0-9]$/u.test(before) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		this.editor.pushUndoStop();
		this.editor.executeEdits('dictation', [{ range: selection, text: separator + text }], inverseEdits =>
			inverseEdits.map(edit => Selection.fromPositions(edit.range.getEndPosition())));
		this.editor.pushUndoStop();
	}

	fitsOnSingleLine(width: number): boolean {
		if (this.model.lineCount !== 1) return false;
		const font = this.editor.getOption(EditorOption.fontInfo);
		const layout = this.editor.getOption(EditorOption.layoutInfo);
		// The compact editor keeps a caret inset, with no space reserved for a scrollbar.
		const contentWidth = width - (layout.width - layout.contentWidth) - CHAT_INPUT_CARET_INSET;
		const injected = this.model.getLineInjectedText(1);
		const line = LineInjectedText.applyInjectedText(this.model.getLineContent(1), injected);
		let measuredWidth = 0;
		let offset = 0;
		for (const range of LineInjectedText.getFixedWidthInjectedTextRanges(injected)) {
			measuredWidth += this.editor.view.measureTextWidth(line.slice(offset, range.startOffset)) + range.widthInEm * font.fontSize;
			offset = range.endOffset;
		}
		measuredWidth += this.editor.view.measureTextWidth(line.slice(offset));
		return measuredWidth <= contentWidth;
	}

	setCompactLayout(compact: boolean, rightPadding: number): boolean {
		const wordWrap = compact ? 'off' : 'on';
		const scrollbarInset = compact ? 0 : Math.min(rightPadding, CHAT_INPUT_SCROLLBAR_WIDTH);
		if (this.editor.getOption(EditorOption.wordWrap) === wordWrap && this.scrollbarInset === scrollbarInset) return false;
		this.scrollbarInset = scrollbarInset;
		this.editor.updateOptions({ wordWrap, scrollbar: { verticalScrollbarSize: scrollbarInset } });
		return true;
	}

	layout(): void {
		const textWidth = this.element.clientWidth;
		if (textWidth <= 0) return;
		// Adaptive inputs place the scrollbar in the form's right padding, outside the text width.
		const width = textWidth + this.scrollbarInset;
		const hadScrollbar = this.scrollbarInset === 0 && this.editor.getOption(EditorOption.scrollbar).verticalScrollbarSize > 0;
		const scrollTop = hadScrollbar ? this.editor.getScrollTop() : 0;
		// Check fit at full width so a scrollbar cannot keep itself visible after text is deleted.
		if (hadScrollbar) this.editor.updateOptions({ scrollbar: { verticalScrollbarSize: 0 } });
		this.editor.layout({ width, height: this.height });
		const contentHeight = this.editor.getBottomForLineNumber(this.model.lineCount) + CHAT_INPUT_EDITOR_PADDING.bottom;
		const needsScrollbar = this.scrollbarInset === 0 && contentHeight > this.maximumHeight;
		if (needsScrollbar) this.editor.updateOptions({ scrollbar: { verticalScrollbarSize: this.verticalScrollbarSize } });
		const height = Math.min(this.maximumHeight, Math.max(this.minimumHeight, contentHeight));
		if (height !== this.height) {
			this.height = height;
			this.element.style.height = `${height}px`;
			this.editor.layout({ width, height });
		}
		if (hadScrollbar && needsScrollbar) this.editor.setScrollTop(scrollTop);
		this.inlineAttachments.layout();
	}

	private getFontOptions(): Pick<CodeEditorWidgetOptions, 'fontFamily' | 'fontSize' | 'lineHeight'> {
		const font = getChatInputEditorFont(this.configurationService);
		const hasAttachmentControls = this.inlineAttachments?.getPillReferences().some(attachment => attachment.kind !== 'file' && attachment.kind !== 'codeSelection') ?? false;
		return {
			...font,
			lineHeight: Math.max(hasAttachmentControls ? 28 : 0, font.lineHeight),
		};
	}
}
