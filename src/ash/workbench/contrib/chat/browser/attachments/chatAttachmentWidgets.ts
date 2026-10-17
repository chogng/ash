import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { DetachedTerminalSnapshotMirror } from '../../../terminal/browser/chatTerminalCommandMirror.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import './chatAttachmentWidgets.css';
import { h } from '../../../../../base/browser/dom.js';
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

/** Controls follow their owning reference; injected text reserves space without changing the message. */
export class InlineChatAttachmentWidget extends Disposable {
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());
	readonly widgets: readonly IContentWidget[];
	private readonly thumbnail: HTMLImageElement | undefined;
	private readonly openButton: Button | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		public attachment: ChatContextAttachment,
		private readonly contextViews: IContextViewService,
		remove: () => void,
		@IOpenerService private readonly opener: IOpenerService,
		@ICommandService private readonly commands: ICommandService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		const document = editor.getDomNode()!.ownerDocument;
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

	open(): void {
		if (this.attachment.kind === 'image' || this.attachment.terminalSnapshot) this.showPreview();
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
