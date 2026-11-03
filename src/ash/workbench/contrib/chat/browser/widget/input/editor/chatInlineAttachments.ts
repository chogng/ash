import { addDisposableListener, stopEvent, h } from '../../../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { type Event } from '../../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Schemas } from '../../../../../../../base/common/network.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { basename } from '../../../../../../../base/common/resources.js';
import { ContentWidgetPositionPreference, MouseTargetType, type ICodeEditor, type IContentWidget } from '../../../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { PositionAffinity, InjectedTextCursorStops, TrackedRangeStickiness, type IModelDecorationOptions, type ITextModel } from '../../../../../../../editor/common/model.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { localize } from '../../../../../../../nls.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import type { ChatContextAttachment } from '../../../../../../services/chat/common/chatContextService.js';
import { dynamicVariableDecorationType } from '../../../attachments/chatDynamicVariables.js';
import { IChatAttachmentWidgetRegistry, type IChatAttachmentWidgetInstance } from '../../../attachments/chatAttachmentWidgetRegistry.js';
import {
	DefaultChatAttachmentWidget, FileAttachmentWidget, ImageAttachmentWidget, TerminalCommandAttachmentWidget,
	ElementChatAttachmentWidget, SCMHistoryItemAttachmentWidget, SCMHistoryItemChangeAttachmentWidget,
	PromptFileAttachmentWidget, ToolSetOrToolItemAttachmentWidget,
} from '../../../attachments/chatAttachmentWidgets.js';
import { registerChatInputReferenceDecorationType } from './chatInputReferenceDecorations.js';
import './media/chatInlineAttachments.css';

/** Owns only the editor projection of the canonical attachment references. */
export class ChatInlineAttachments extends Disposable {
	private readonly model: ITextModel;
	private readonly referenceWidgets = new Map<string, InlineChatAttachmentWidget>();
	private readonly referenceStyle: IModelDecorationOptions;
	private referenceDecorations: string[] = [];
	private codeReferences: readonly ChatContextAttachment[] = [];
	private readonly snapshotResources = new WeakMap<ChatContextAttachment['resolve'], URI>();

	constructor(
		private readonly editor: ICodeEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICodeEditorService codeEditors: ICodeEditorService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		// This embedded input keeps one model for its lifetime; borrow it through teardown.
		this.model = editor.getModel()!;
		this._register(registerChatInputReferenceDecorationType(codeEditors));
		this.referenceStyle = codeEditors.resolveDecorationOptions(dynamicVariableDecorationType, false);
		this._register(toDisposable(() => {
			for (const widget of this.referenceWidgets.values()) widget.dispose();
			this.referenceWidgets.clear();
			if (!this.model.isDisposed()) this.model.deltaDecorations(this.referenceDecorations, []);
			this.referenceDecorations = [];
		}));
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
		this._register(addDisposableListener(this.editor.getDomNode()!, 'keydown', event => {
			if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || this.referenceWidgets.size === 0) return;
			const buttons = [...this.referenceWidgets.values()]
				.sort((a, b) => a.attachment.reference!.start - b.attachment.reference!.start)
				.flatMap(widget => widget.widgets.flatMap(control => [...control.getDomNode().querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]));
			if (buttons.length === 0) return;
			if (this.editor.hasTextFocus() && !event.shiftKey) {
				stopEvent(event);
				buttons[0]!.focus();
			} else if (event.target === buttons[0] && event.shiftKey) {
				stopEvent(event);
				this.editor.focus();
			}
		}));
	}

	getPillReferences(): readonly ChatContextAttachment[] {
		return [...this.referenceWidgets.values()].map(widget => widget.attachment);
	}

	openActivePill(): boolean {
		const selection = this.editor.getSelection();
		const offset = selection?.isEmpty() ? this.model.getOffsetAt(selection.getPosition()) : -1;
		const widget = [...this.referenceWidgets.values()].find(widget => offset >= widget.attachment.reference!.start && offset <= widget.attachment.reference!.end);
		if (!widget) return false;
		widget.open();
		return true;
	}

	layout(): void {
		this.editor.getDomNode()!.style.setProperty('--ash-chat-context-reference-height', `${this.editor.getOption(EditorOption.lineHeight)}px`);
		this.updateReferenceWidths();
	}

	refresh(references: readonly ChatContextAttachment[], remove: (id: string) => void): void {
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
						inlineClassName: code ? 'ash-chat-code-reference-space' : 'ash-chat-attachment-reference-space',
						attachedData: context.kind === 'image' ? context : context.id,
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
				message.appendText(`\n${context.open
					? localize('chat.context.openProviderSourceHint', 'Click to open the source provided by the extension, or press Alt+Enter at the reference.')
					: localize('chat.context.openSavedContentHint', 'Click to open the full saved content, or press Alt+Enter at the reference.')}`);
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
				if (!options?.before?.replaceLength) continue;
				const reference = options.before.attachedData as string | ChatContextAttachment;
				const widget = this.referenceWidgets.get(typeof reference === 'string' ? reference : reference.id);
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

}

function getReferenceContent(context: ChatContextAttachment, content: string): string {
	const source = context.resource ? `Source: ${context.resource.toString()}\n\n` : '';
	return context.kind === 'codeSelection' && source && content.startsWith(source) ? content.slice(source.length) : content;
}

interface SavedContentAttachmentWidget {
	readonly onDidOpen: Event<void>;
	setHoverMessage(message: MarkdownString): void;
	hideHover(): void;
}

/** Owns editor projection only; each attachment widget owns its DOM and actions. */
class InlineChatAttachmentWidget extends Disposable {
	readonly widgets: readonly IContentWidget[];
	private readonly fileWidget: FileAttachmentWidget | undefined;
	private readonly savedContentWidget: SavedContentAttachmentWidget | undefined;
	private readonly attachmentWidget: IChatAttachmentWidgetInstance;

	constructor(
		private readonly editor: ICodeEditor,
		public attachment: ChatContextAttachment,
		remove: () => void,
		openSaved: (() => void) | undefined,
		@IChatAttachmentWidgetRegistry registry: IChatAttachmentWidgetRegistry,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = editor.getDomNode()!.ownerDocument;
		const host = h(document, 'div');
		const options = { shouldFocusClearButton: false, supportsDeletion: true };
		let content: IChatAttachmentWidgetInstance | undefined;
		try {
			if (attachment.kind === 'file' || attachment.kind === 'codeSelection' || attachment.kind === 'directory') {
				content = this.fileWidget = instantiation.createInstance(FileAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'image') {
				content = instantiation.createInstance(ImageAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'terminal' || attachment.kind === 'terminalCommand' || attachment.terminalSnapshot) {
				content = instantiation.createInstance(TerminalCommandAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'browserElement') {
				content = instantiation.createInstance(ElementChatAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'scmHistoryItem') {
				content = instantiation.createInstance(SCMHistoryItemAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'scmHistoryItemChange') {
				content = instantiation.createInstance(SCMHistoryItemChangeAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'instruction') {
				content = instantiation.createInstance(PromptFileAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'tool' || attachment.kind === 'toolSet' || attachment.kind === 'toolSelection') {
				content = instantiation.createInstance(ToolSetOrToolItemAttachmentWidget, attachment, options, host);
			} else {
				content = registry.createWidget(attachment, options, host);
				if (!content && attachment.kind === 'sessionReference') throw new Error('Missing Chat reference attachment widget registration');
				content ??= instantiation.createInstance(DefaultChatAttachmentWidget, attachment, options, host);
			}
		} catch (error) {
			this.dispose();
			throw error;
		}
		this.attachmentWidget = this._register(content);
		this._register(content.onDidDelete(remove));
		host.className = this.fileWidget ? 'ash-chat-code-reference-widget' : 'ash-chat-reference-attachment-widget';
		if (this.fileWidget) {
			const file = this.fileWidget;
			if (attachment.kind !== 'directory') this.savedContentWidget = file;
			this._register(addDisposableListener(file.element, 'dblclick', event => {
				if (!(event.target as HTMLElement).closest('.ash-chat-code-reference-source')) return;
				event.preventDefault();
				const model = editor.getModel()!;
				const reference = this.attachment.reference!;
				editor.setSelection({
					startLineNumber: model.getPositionAt(reference.start).lineNumber, startColumn: model.getPositionAt(reference.start).column,
					endLineNumber: model.getPositionAt(reference.end).lineNumber, endColumn: model.getPositionAt(reference.end).column,
				});
				editor.focus();
			}));
		}
		if (content instanceof ElementChatAttachmentWidget || content instanceof SCMHistoryItemAttachmentWidget || content instanceof SCMHistoryItemChangeAttachmentWidget || content instanceof DefaultChatAttachmentWidget && !attachment.resource) {
			this.savedContentWidget = content;
		}
		if (this.savedContentWidget) {
			// Provider source actions keep the saved-content hover without opening a second editor.
			if (!attachment.open) this._register(this.savedContentWidget.onDidOpen(() => openSaved?.()));
			this._register(editor.onDidChangeCursorSelection(() => this.savedContentWidget?.hideHover()));
		}
		this.widgets = [this.addContentWidget(host)];
	}

	get opensSavedContent(): boolean {
		return this.savedContentWidget !== undefined;
	}

	get widthInEm(): number {
		const font = this.editor.getOption(EditorOption.fontInfo);
		// Cursor positions use whole pixels; reserve the complete fractional-width surface.
		return Math.ceil(this.attachmentWidget.element.getBoundingClientRect().width || this.attachment.name.length * font.typicalHalfwidthCharacterWidth + 28) / font.fontSize;
	}

	setSelected(selected: boolean): void {
		this.attachmentWidget.element.classList.toggle('selected', selected);
	}

	setHoverMessage(message: MarkdownString): void {
		this.savedContentWidget?.setHoverMessage(message);
	}

	open(): void {
		if (this.isDisposed) return;
		this.attachmentWidget.element.click();
	}

	private addContentWidget(node: HTMLElement): IContentWidget {
		const widget: IContentWidget = {
			getId: () => `chat-context-${this.attachment.id}`,
			getDomNode: () => node,
			getPosition: () => ({
				position: this.editor.getModel()!.getPositionAt(this.attachment.reference!.start),
				positionAffinity: PositionAffinity.LeftOfInjectedText,
				preference: [ContentWidgetPositionPreference.EXACT],
			}),
		};
		this.editor.addContentWidget(widget);
		this._register(toDisposable(() => this.editor.removeContentWidget(widget)));
		return widget;
	}
}
