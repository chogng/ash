import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { DetachedTerminalSnapshotMirror } from '../../../terminal/browser/chatTerminalCommandMirror.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import './chatAttachmentWidgets.css';
import { h, addDisposableListener } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { Schemas } from '../../../../../base/common/network.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../../files/browser/fileConstants.js';
import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { FOCUS_SEARCH_COMMAND_ID } from '../../../search/common/constants.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget } from '../../../../../editor/browser/editorBrowser.js';
import { PositionAffinity } from '../../../../../editor/common/model.js';
import { ContextViewFocusRestore } from '../../../../../base/browser/ui/contextview/contextview.js';
import type { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import type { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';

/** Controls follow their owning reference; injected text reserves space without changing the message. */
export class InlineChatAttachmentWidget extends Disposable {
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());
	readonly widgets: readonly IContentWidget[];
	private readonly thumbnail: HTMLImageElement | undefined;
	private readonly openButton: Button | undefined;
	private readonly codeChip: HTMLElement | undefined;
	private readonly fileSource: HTMLButtonElement | undefined;
	private readonly hover = this._register(new MutableDisposable<DisposableStore>());
	private hoverControl: IManagedHover | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		public attachment: ChatContextAttachment,
		private readonly contextViews: IContextViewService,
		remove: () => void,
		private readonly openSaved: (() => void) | undefined,
		@IOpenerService private readonly opener: IOpenerService,
		@ICommandService private readonly commands: ICommandService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IResourceIconRenderer private readonly resourceIcons: IResourceIconRenderer,
	) {
		super();
		const document = editor.getDomNode()!.ownerDocument;
		if (attachment.kind === 'file' || attachment.kind === 'codeSelection') {
			const host = h(document, 'div');
			host.className = 'ash-chat-code-reference-widget';
			const chip = this.codeChip = h(document, 'div');
			chip.className = 'ash-chat-code-reference-chip';
			host.append(chip);
			const source = this.fileSource = h(document, 'button');
			source.type = 'button';
			source.className = 'ash-chat-code-reference-source';
			source.setAttribute('aria-label', localize('chat.context.open', 'Open {0}', attachment.name));
			chip.append(source);
			const label = this._register(new IconLabel(source, {
				label: attachment.name,
				reserveIconSpace: true,
			}));
			label.labelElement.classList.add('ash-chat-code-reference');
			const renderIcon = () => {
				const resource = this.attachment.resource;
				const placeholder = !resource || resource.scheme === 'output' || resource.scheme === 'inmemory';
				label.setIcon(undefined, placeholder ? undefined : container => {
					const glyph = h(document, 'span');
					container.append(glyph);
					if (this.resourceIcons.getFileIconTheme().hasFileIcons) this.resourceIcons.renderFileIcon(resource, glyph);
					else appendIcon(Lxicon.file, glyph);
				}, true);
				label.iconElement.classList.add('ash-chat-code-reference-icon');
				label.iconElement.classList.toggle('placeholder', placeholder);
			};
			renderIcon();
			this._register(resourceIcons.onDidChangeResourceIcons(renderIcon));
			this._register(addDisposableListener(source, 'click', () => this.open()));
			this._register(editor.onDidChangeCursorSelection(() => this.hoverControl?.hide()));
			this._register(addDisposableListener(source, 'dblclick', event => {
				event.preventDefault();
				const model = editor.getModel()!;
				const reference = this.attachment.reference!;
				editor.setSelection({
					startLineNumber: model.getPositionAt(reference.start).lineNumber, startColumn: model.getPositionAt(reference.start).column,
					endLineNumber: model.getPositionAt(reference.end).lineNumber, endColumn: model.getPositionAt(reference.end).column,
				});
				editor.focus();
			}));
			const widget: IContentWidget = {
				getId: () => `chat-context-${attachment.id}`,
				getDomNode: () => host,
				getPosition: () => ({
					position: editor.getModel()!.getPositionAt(this.attachment.reference!.start),
					positionAffinity: PositionAffinity.LeftOfInjectedText,
					preference: [ContentWidgetPositionPreference.EXACT],
				}),
			};
			this.widgets = [widget];
			editor.addContentWidget(widget);
			this._register(toDisposable(() => editor.removeContentWidget(widget)));
			return;
		}
		const controls: { node: HTMLElement; before: boolean; }[] = [];
		const controlClass = attachment.kind === 'image' ? 'ash-chat-context-reference-control ash-chat-image-reference-control' : 'ash-chat-context-reference-control';
		if (attachment.kind === 'image' || attachment.terminalSnapshot || attachment.resource) {
			const before = h(document, 'div');
			before.className = controlClass;
			this.openButton = this._register(new Button(before, {
				...defaultButtonStyles,
				label: '',
				ariaLabel: attachment.kind === 'image'
					? localize('chat.context.previewImage', 'Preview {0}', attachment.name)
					: attachment.terminalSnapshot ? localize('terminal.chat.preview', 'Preview terminal snapshot') : localize('chat.context.open', 'Open {0}', attachment.name),
				...(attachment.kind === 'image' ? {} : { icon: attachment.terminalSnapshot ? Lxicon.terminal : Lxicon.file, iconOnly: true }),
				size: 'small',
				presentation: 'quiet',
			}));
			if (attachment.kind === 'image') {
				this.thumbnail = h(document, 'img');
				this.thumbnail.alt = attachment.name;
				this.openButton.domNode.append(this.thumbnail);
			}
			this._register(this.openButton.onDidClick(() => this.open()));
			controls.push({ node: before, before: true });
		}
		const after = h(document, 'div');
		after.className = controlClass;
		const deleteButton = this._register(new Button(after, {
			...defaultButtonStyles,
			label: localize('chat.attach.remove', 'Remove {0}', attachment.name),
			icon: Lxicon.close,
			iconOnly: true,
			size: 'small',
			presentation: 'quiet',
		}));
		this._register(deleteButton.onDidClick(remove));
		controls.push({ node: after, before: false });
		this.widgets = controls.map(({ node, before }, index) => ({
			getId: () => `chat-context-${attachment.id}-${index}`,
			getDomNode: () => node,
			getPosition: () => ({
				position: editor.getModel()!.getPositionAt(before ? this.attachment.reference!.start : this.attachment.reference!.end),
				positionAffinity: PositionAffinity.LeftOfInjectedText,
				preference: [ContentWidgetPositionPreference.EXACT],
			}),
		}));
		for (const widget of this.widgets) editor.addContentWidget(widget);
		this._register(toDisposable(() => { for (const widget of this.widgets) editor.removeContentWidget(widget); }));
		if (this.thumbnail) void attachment.resolve().then(context => {
			if (!this.isDisposed && this.thumbnail && /^data:image\/(png|jpeg|gif|webp);base64,/u.test(context.content)) this.thumbnail.src = context.content;
		}, () => {
			if (!this.isDisposed && this.thumbnail) this.thumbnail.alt = localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name);
		});
	}

	get widthInEm(): number {
		const font = this.editor.getOption(EditorOption.fontInfo);
		return (this.codeChip?.getBoundingClientRect().width || this.attachment.name.length * font.typicalHalfwidthCharacterWidth + 28) / font.fontSize;
	}

	setSelected(selected: boolean): void {
		this.codeChip?.classList.toggle('selected', selected);
	}

	setHoverMessage(message: MarkdownString): void {
		if (!this.fileSource) return;
		const resources = new DisposableStore();
		const content = resources.add(renderMarkdown(message, { ownerDocument: this.fileSource.ownerDocument }));
		this.hoverControl = resources.add(getHoverDelegate().setupHover({ target: this.fileSource, content: content.element }));
		this.hover.value = resources;
	}

	open(): void {
		if (this.openSaved) this.openSaved();
		else if (this.attachment.kind === 'image' || this.attachment.terminalSnapshot) this.showPreview();
		else void this.openSource();
	}

	private async openSource(): Promise<void> {
		const resource = this.attachment.resource;
		if (!resource) return;
		try {
			if (resource.scheme === Schemas.internal && resource.authority === 'chat-session') {
				const parameters = new URLSearchParams(resource.query);
				const sessionId = parameters.get('sessionId');
				const threadId = parameters.get('threadId');
				if (sessionId && threadId) await this.navigation.openConversation(sessionId, threadId);
			} else if (resource.scheme === Schemas.internal && resource.authority === 'agent-tools') {
				await this.commands.executeCommand(OpenSettingsCommandId, { section: 'tools' });
			} else if (resource.scheme === Schemas.internal && resource.authority === 'terminal') {
				const id = new URLSearchParams(resource.query).get('id');
				if (id) await this.commands.executeCommand(TerminalCommandId.Focus, id);
			} else if (resource.scheme === Schemas.internal && resource.authority === 'search-results') {
				await this.commands.executeCommand(FOCUS_SEARCH_COMMAND_ID);
			} else if (this.attachment.kind === 'directory') {
				await this.commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, resource);
			} else {
				await this.opener.open(resource, { fromUserGesture: true, openExternal: resource.scheme === Schemas.https || resource.scheme === Schemas.http });
			}
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(localize('chat.context.openFailed', 'Could not open {0}: {1}', this.attachment.name, String(error)));
		}
	}

	private showPreview(): void {
		const snapshot = this.attachment.terminalSnapshot;
		if (this.isDisposed || !this.openButton || !snapshot && !this.thumbnail?.src) return;
		const document = this.openButton.domNode.ownerDocument;
		const content = h(document, 'div');
		content.className = 'ash-chat-context-reference-preview ' + (snapshot ? 'ash-chat-terminal-reference-preview' : 'ash-chat-image-reference-preview');
		content.dataset.attachmentId = this.attachment.id;
		content.setAttribute('role', 'dialog');
		content.setAttribute('aria-label', snapshot ? localize('terminal.chat.previewLabel', 'Saved terminal output: {0}', this.attachment.name) : localize('chat.context.previewImage', 'Preview {0}', this.attachment.name));
		const header = h(document, 'div');
		header.className = 'ash-chat-context-reference-preview-header';
		const title = h(document, 'span');
		title.textContent = this.attachment.name;
		header.append(title);
		content.append(header);
		const resources = new DisposableStore();
		const close = resources.add(new Button(header, {
			...defaultButtonStyles,
			label: snapshot ? localize('terminal.chat.previewClose', 'Close terminal preview') : localize('chat.context.closeImagePreview', 'Close image preview'),
			icon: Lxicon.close,
			iconOnly: true,
			size: 'small',
			presentation: 'quiet',
		}));
		resources.add(close.onDidClick(() => this.contextViews.hide()));
		let mirror: DetachedTerminalSnapshotMirror | undefined;
		if (snapshot) {
			const screen = h(document, 'div');
			screen.className = 'ash-chat-terminal-preview-screen';
			content.append(screen);
			mirror = resources.add(this.instantiation.createInstance(DetachedTerminalSnapshotMirror, screen));
			if (this.attachment.resource) {
				const source = resources.add(new Button(header, {
					...defaultButtonStyles,
					label: localize('chat.context.open', 'Open {0}', this.attachment.name),
					icon: Lxicon.terminal,
					iconOnly: true,
					size: 'small',
					presentation: 'quiet',
				}));
				resources.add(source.onDidClick(() => { void this.openSource(); }));
			}
		} else {
			const image = h(document, 'img');
			image.alt = this.attachment.name;
			image.src = this.thumbnail!.src;
			content.append(image);
		}
		let visible = false;
		resources.add(toDisposable(() => { if (visible) this.contextViews.hide(); }));
		this.preview.value = resources;
		visible = this.contextViews.show({
			anchor: this.openButton.domNode, content, presentation: 'dialog', focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => { visible = false; this.preview.clear(); },
		});
		if (visible) {
			close.focus();
			// Initialize the passive screen after the dialog has real geometry. The frozen
			// snapshot and mirror lifetime stay independent of the original terminal.
			if (mirror && snapshot) void mirror.render(snapshot).catch(() => {
				if (!resources.isDisposed) this.notifications.error(localize('chat.context.previewFailed', 'Preview unavailable: {0}', this.attachment.name));
			});
		} else this.preview.clear();
	}
}
