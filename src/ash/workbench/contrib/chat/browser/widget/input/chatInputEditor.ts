import { Selection } from '../../../../../../editor/common/core/selection.js';
import type { ChatInputEditorSelection } from './chatInputEditorRegistry.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { DEFAULT_FONT_FAMILY } from '../../../../../../base/browser/fonts.js';
import './chatInputEditor.css';
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
import { type ChatInputEditorOptions, type IChatInputEditor } from './chatInputEditorRegistry.js';
import { CHAT_INPUT_LANGUAGE_ID, createChatCommandCompletionProvider, createChatSkillCompletionProvider } from './editor/chatInputCompletions.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';
import { InlineChatAttachmentWidget } from '../../attachments/chatAttachmentWidgets.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { InjectedTextCursorStops, TrackedRangeStickiness, type IModelDecorationOptions } from '../../../../../../editor/common/model.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { dynamicVariableDecorationType } from '../../attachments/chatDynamicVariables.js';
import { registerChatInputReferenceDecorationType } from './editor/chatInputReferenceDecorations.js';
import { localize } from '../../../../../../nls.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { basename } from '../../../../../../base/common/resources.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { CopyPasteController } from '../../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { MouseTargetType } from '../../../../../../editor/browser/editorBrowser.js';
import { PlaceholderTextContribution } from '../../../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import { EditorContributionInstantiation } from '../../../../../../editor/browser/editorExtensions.js';
import '../../../../../../editor/contrib/placeholderText/browser/placeholderText.css';

const CHAT_INPUT_EDITOR_PADDING = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
// The input container owns the inset; editor heights exclude it to avoid applying it twice.
const CHAT_INPUT_MIN_HEIGHT = 40;
const CHAT_INPUT_MAX_HEIGHT = 314;

/** Stanza-backed embedded editor hosted by the Chat input part. */
export class ChatInputEditor extends Disposable implements IChatInputEditor {
	readonly element: HTMLDivElement;
	private readonly model = this._register(new TextModel('', { languageId: CHAT_INPUT_LANGUAGE_ID }));
	private readonly editor: CodeEditorWidget;
	public get codeEditor(): CodeEditorWidget { return this.editor; }
	private readonly _onDidChange = this._register(new Emitter<string>());
	private readonly _onDidSubmit = this._register(new Emitter<void>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	readonly onDidSubmit: Event<void> = this._onDidSubmit.event;
	private height = CHAT_INPUT_MIN_HEIGHT;
	private readonly minimumHeight: number;
	private readonly maximumHeight: number;
	private readonly tabFocusMode: boolean;
	private readonly referenceWidgets = new Map<string, InlineChatAttachmentWidget>();
	private readonly referenceStyle: IModelDecorationOptions;
	private referenceDecorations: string[] = [];
	private codeReferences: readonly ChatContextAttachment[] = [];
	private readonly snapshotResources = new WeakMap<ChatContextAttachment['resolve'], URI>();

	constructor(
		options: ChatInputEditorOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService codeEditors: ICodeEditorService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.minimumHeight = options.height?.minimum ?? CHAT_INPUT_MIN_HEIGHT;
		this.maximumHeight = options.height?.maximum ?? CHAT_INPUT_MAX_HEIGHT;
		this.tabFocusMode = options.tabFocusMode ?? false;
		this.height = this.minimumHeight;
		this.element = h(options.container.ownerDocument, 'div');
		this.element.className = 'ash-chat-input-editor';
		this.element.style.height = `${this.height}px`;
		this.element.style.minHeight = `${this.minimumHeight}px`;
		options.container.append(this.element);
		const completionProviders = [
			createChatCommandCompletionProvider(options.slashCommands),
			createChatSkillCompletionProvider(options.skills),
		];
		// Keep basic text commands alongside Chat features; unrelated editor features add work to every Chat tab.
		const contributionIds = [EditorCoreCommandId.selectAll, 'editor.contrib.codeServices', 'editor.contrib.suggestController', 'editor.contrib.hover', CopyPasteController.ID];
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
			lineWrapping: EditorLineWrapping.On,
			tabFocusMode: this.tabFocusMode,
			contributionIds,
			// Plain-text hosts do not activate the full editor feature package.
			contributions: [{ id: PlaceholderTextContribution.ID, ctor: PlaceholderTextContribution, instantiation: EditorContributionInstantiation.Eager }],
			completionProviders,
			completionWidgetContainer: this.element,
		}));
		this._register(registerChatInputReferenceDecorationType(codeEditors));
		this.referenceStyle = codeEditors.resolveDecorationOptions(dynamicVariableDecorationType, false);
		const layout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(toDisposable(() => { for (const widget of this.referenceWidgets.values()) widget.dispose(); this.referenceWidgets.clear(); }));
		this._register(this.editor.onDidChangeCursorSelection(() => this.updateReferenceSelection()));
		this._register(this.editor.onMouseUp(event => {
			// Native attachment controls own activation, including clicks on their chip padding.
			if (event.target.type === MouseTargetType.CONTENT_WIDGET || event.target.element?.closest('button')) return;
			if (!event.event.leftButton || !event.target.position || !this.editor.getSelection()?.isEmpty()) return;
			const offset = this.model.getOffsetAt(event.target.position);
			const context = this.codeReferences.find(context => offset >= context.reference!.start && offset < context.reference!.end)
				?? this.codeReferences.find(context => offset === context.reference!.end);
			if (context) {
				if (event.event.detail === 1 && !event.event.shiftKey && !event.event.altKey && !event.event.ctrlKey && !event.event.metaKey) {
					this.referenceWidgets.get(context.id)?.open();
				}
				return;
			}
			for (const widget of this.referenceWidgets.values()) {
				const reference = widget.attachment.reference!;
				if (offset >= reference.start && offset < reference.end) { widget.open(); break; }
			}
		}));
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
			if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
			if (event.altKey && !event.ctrlKey && !event.metaKey) {
				stopEvent(event);
				const selection = this.editor.getSelection();
				const offset = selection?.isEmpty() ? this.model.getOffsetAt(selection.getPosition()) : -1;
				const widget = [...this.referenceWidgets.values()].find(widget => offset >= widget.attachment.reference!.start && offset <= widget.attachment.reference!.end);
				widget?.open();
				return;
			}
			if (this.editor.getOption(EditorOption.readOnly)) return;
			stopEvent(event);
			this._onDidSubmit.fire();
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || this.referenceWidgets.size === 0) return;
			const buttons = [...this.referenceWidgets.values()]
				.sort((a, b) => a.attachment.reference!.start - b.attachment.reference!.start)
				.flatMap(widget => widget.widgets.flatMap(control => [...control.getDomNode().querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]));
			if (buttons.length === 0) return;
			if (event.target === this.editor.controller.element && !event.shiftKey) {
				stopEvent(event);
				buttons[0]!.focus();
			} else if (event.target === buttons[0] && event.shiftKey) {
				stopEvent(event);
				this.focus();
			}
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
		if (references.length === 0 && this.referenceWidgets.size === 0 && this.referenceDecorations.length === 0) return;
		const inline = references.filter(context => context.reference);
		this.codeReferences = inline.filter(context => context.kind === 'file' || context.kind === 'codeSelection');
		const ids = new Set(inline.map(reference => reference.id));
		for (const [id, widget] of this.referenceWidgets) {
			if (!ids.has(id)) { widget.dispose(); this.referenceWidgets.delete(id); }
		}
		for (const reference of inline) {
			let widget = this.referenceWidgets.get(reference.id);
			if (widget && (widget.attachment.kind !== reference.kind || widget.attachment.name !== reference.name
				|| widget.attachment.resource?.toString() !== reference.resource?.toString() || widget.attachment.resolve !== reference.resolve)) {
				widget.dispose();
				widget = undefined;
			}
			if (!widget) {
				const open = () => { void this.openSavedContent(reference); };
				widget = this.instantiationService.createInstance(InlineChatAttachmentWidget, this.editor, reference, () => remove(reference.id), open);
				this.referenceWidgets.set(reference.id, widget);
			} else widget.attachment = reference;
			for (const contentWidget of widget.widgets) this.editor.layoutContentWidget(contentWidget);
		}
		this.editor.updateOptions({ ...this.getFontOptions(), tabFocusMode: this.tabFocusMode || inline.length > 0 });
		this.layout();
		const decorations = inline.map(context => {
			const code = context.kind === 'file' || context.kind === 'codeSelection';
			const savedContent = this.referenceWidgets.get(context.id)!.opensSavedContent;
			const hoverMessage = savedContent || code || context.kind !== 'image' && context.resource ? new MarkdownString().appendText(context.name) : undefined;
			if (context.resource && context.resource.scheme !== 'output' && context.resource.scheme !== Schemas.internal) hoverMessage?.appendText(`\n${context.resource.toString(true)}`);
			return {
				range: Range.fromPositions(this.model.getPositionAt(context.reference!.start), this.model.getPositionAt(context.reference!.end)),
				options: {
					description: 'chat-context-reference',
					stickiness: code ? this.referenceStyle.stickiness : TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					hoverMessage,
					before: {
						content: '\uFFFC', replaceLength: context.reference!.end - context.reference!.start,
						widthInEm: this.referenceWidgets.get(context.id)!.widthInEm,
						inlineClassName: code ? 'ash-chat-code-reference-space' : 'ash-chat-attachment-reference-space', attachedData: context.id,
						cursorStops: InjectedTextCursorStops.Both,
					},
				},
			};
		});
		this.referenceDecorations = this.model.deltaDecorations(this.referenceDecorations, decorations);
		this.updateReferenceSelection();
		for (const [index, context] of inline.entries()) {
			const widget = this.referenceWidgets.get(context.id)!;
			if (!widget.opensSavedContent) continue;
			const id = this.referenceDecorations[index]!;
			const options = decorations[index]!.options;
			const update = (message: MarkdownString) => {
				// A delayed snapshot must not revive a removed reference or another draft's hover.
				if (this.isDisposed || this.referenceWidgets.get(context.id) !== widget || !this.model.getDecorationRange(id)) return;
				const current = this.model.getDecorationOptions(id);
				if (current) this.model.changeDecorations(accessor => accessor.changeDecorationOptions(id, { ...current, hoverMessage: message }));
				widget.setHoverMessage(message);
			};
			// Resolve through the reference's snapshot owner, shared with persistence and submission.
			void context.resolve().then(resolved => {
				const text = getReferenceContent(context, resolved.content);
				const preview = text.split('\n', 13).slice(0, 12).join('\n').slice(0, 4000);
				const message = MarkdownString.lift(options.hoverMessage!);
				if (preview) message.appendCodeblock('plaintext', preview);
				if (preview.length < text.length) message.appendText(localize('chat.context.previewTruncated', 'Preview shortened. The full content is attached.'));
				else if (!preview) message.appendText(`\n${localize('chat.context.previewEmpty', 'The attached content is empty.')}`);
				message.appendText(`\n${localize('chat.context.openSavedContentHint', 'Click to open the full saved content, or press Alt+Enter at the reference.')}`);
				update(message);
			}, () => update(MarkdownString.lift(options.hoverMessage!).appendText(`\n${localize('chat.context.previewUnavailable', 'Content preview unavailable.')}`)));
		}
		this.layout();
	}

	private updateReferenceSelection(): void {
		const selections = this.editor.getSelections() ?? [];
		for (const widget of this.referenceWidgets.values()) {
			const reference = widget.attachment.reference!;
			widget.setSelected(selections.some(selection => !selection.isEmpty()
				&& this.model.getOffsetAt(selection.getStartPosition()) < reference.end
				&& this.model.getOffsetAt(selection.getEndPosition()) > reference.start));
		}
	}

	private updateReferenceWidths(): void {
		this.model.changeDecorations(accessor => {
			for (const id of this.referenceDecorations) {
				const options = this.model.getDecorationOptions(id);
				if (!options?.before?.replaceLength || typeof options.before.attachedData !== 'string') continue;
				const widget = this.referenceWidgets.get(options.before.attachedData);
				if (!widget) continue;
				const width = widget.widthInEm;
				if (Math.abs(width - (options.before.widthInEm ?? 0)) < 0.01) continue;
				accessor.changeDecorationOptions(id, { ...options, before: { ...options.before, widthInEm: width } });
				for (const content of widget.widgets) this.editor.layoutContentWidget(content);
			}
		});
	}

	private async openSavedContent(context: ChatContextAttachment): Promise<void> {
		const isCurrent = () => !this.isDisposed && this.referenceWidgets.get(context.id)?.attachment.resolve === context.resolve;
		try {
			const resolved = await context.resolve();
			if (!isCurrent()) return;
			let resource = this.snapshotResources.get(context.resolve);
			if (!resource) {
				// Separate resource identity keeps snapshots independent of the live source and of each other.
				resource = URI.from({ scheme: 'chat-context-snapshot', path: `/${createUuid()}/${context.resource ? basename(context.resource) : 'snapshot.txt'}` });
				this.snapshotResources.set(context.resolve, resource);
			}
			await this.editors.openEditor({
				resource,
				label: localize('chat.context.savedContentTitle', '{0} — Saved content', context.name),
				initialText: getReferenceContent(context, resolved.content),
				contentType: 'text/plain',
				readOnly: true,
				showBreadcrumbs: false,
				...(context.resource?.scheme === 'output' ? { languageId: 'plaintext' } : {}),
			}, { pinned: true });
		} catch (error) {
			if (isCurrent()) this.notifications.error(localize('chat.context.openSavedContentFailed', 'Could not open saved content for {0}: {1}', context.name, String(error)));
		}
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

	public insertText(text: string): void {
		const selection = this.editor.getSelection()!;
		const before = this.value.slice(0, this.model.offsetAt(selection.getStartPosition()));
		const separator = /[A-Za-z0-9]$/u.test(before) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		this.editor.pushUndoStop();
		this.editor.executeEdits('dictation', [{ range: selection, text: separator + text }], inverseEdits =>
			inverseEdits.map(edit => Selection.fromPositions(edit.range.getEndPosition())));
		this.editor.pushUndoStop();
	}

	layout(): void {
		const width = this.element.clientWidth;
		if (width <= 0) return;
		this.element.style.setProperty('--ash-chat-context-reference-height', `${this.editor.getOption(EditorOption.lineHeight)}px`);
		this.editor.layout({ width, height: this.height });
		this.updateReferenceWidths();
		this.syncHeight();
	}

	private getFontOptions(): Pick<CodeEditorWidgetOptions, 'fontFamily' | 'fontSize' | 'lineHeight'> {
		const hasAttachmentControls = [...this.referenceWidgets.values()].some(widget => widget.attachment.kind !== 'file' && widget.attachment.kind !== 'codeSelection');
		return {
			fontFamily: this.configurationService.getValue<string>(ChatInputConfiguration.fontFamily) || DEFAULT_FONT_FAMILY,
			fontSize: this.configurationService.getValue<number>(ChatInputConfiguration.fontSize),
			lineHeight: Math.max(hasAttachmentControls ? 28 : 0, this.configurationService.getValue<number>(ChatInputConfiguration.lineHeight)),
		};
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

function getReferenceContent(context: ChatContextAttachment, content: string): string {
	const source = context.resource ? `Source: ${context.resource.toString()}\n\n` : '';
	return context.kind === 'codeSelection' && source && content.startsWith(source) ? content.slice(source.length) : content;
}
