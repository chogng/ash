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
import {
	ContentWidgetPositionPreference,
	type ICodeEditor,
	type IContentWidget,
} from '../../../../../editor/browser/editorBrowser.js';
import { PositionAffinity } from '../../../../../editor/common/model.js';
import { ContextViewFocusRestore } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import type { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { cancelOnDispose, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { SCMHistoryItemUri } from '../../../scm/common/history.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { IChatAttachmentWidgetRegistry, type IChatAttachmentWidgetInstance } from './chatAttachmentWidgetRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import {
	ResourceContext,
	ResourceSchemeContext,
	ResourceSetContext,
	ResourcePathContext,
	ResourceFilenameContext,
	ResourceDirnameContext,
	ResourceExtensionContext,
	MultipleEditorsSelectedInGroupContext,
} from '../../../../common/contextkeys.js';
import { ExplorerFolderContext } from '../../../files/common/files.js';
import { fillEditorsDragData } from '../../../../browser/dnd.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { extname } from '../../../../../base/common/path.js';
import type { URI } from '../../../../../base/common/uri.js';

interface SavedContentAttachmentWidget {
	readonly onDidOpen: Event<void>;
	setHoverMessage(message: MarkdownString): void;
	hideHover(): void;
}

/** Owns editor projection only; each attachment widget owns its DOM and actions. */
export class InlineChatAttachmentWidget extends Disposable {
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
				content = this.fileWidget = instantiation.createInstance(
					FileAttachmentWidget,
					attachment,
					options,
					host,
				);
			} else if (attachment.kind === 'image') {
				content = instantiation.createInstance(ImageAttachmentWidget, attachment, options, host);
			} else if (
				attachment.kind === 'terminal' ||
				attachment.kind === 'terminalCommand' ||
				attachment.terminalSnapshot
			) {
				content = instantiation.createInstance(TerminalCommandAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'browserElement') {
				content = instantiation.createInstance(ElementChatAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'scmHistoryItem') {
				content = instantiation.createInstance(SCMHistoryItemAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'scmHistoryItemChange') {
				content = instantiation.createInstance(SCMHistoryItemChangeAttachmentWidget, attachment, options, host);
			} else if (attachment.kind === 'instruction') {
				content = instantiation.createInstance(PromptFileAttachmentWidget, attachment, options, host);
			} else if (
				attachment.kind === 'tool' ||
				attachment.kind === 'toolSet' ||
				attachment.kind === 'toolSelection'
			) {
				content = instantiation.createInstance(ToolSetOrToolItemAttachmentWidget, attachment, options, host);
			} else {
				content = registry.createWidget(attachment, options, host);
				if (!content && attachment.kind === 'sessionReference')
					throw new Error('Missing Chat reference attachment widget registration');
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
			this._register(
				addDisposableListener(file.element, 'dblclick', event => {
					if (!(event.target as HTMLElement).closest('.ash-chat-code-reference-source')) return;
					event.preventDefault();
					const model = editor.getModel()!;
					const reference = this.attachment.reference!;
					editor.setSelection({
						startLineNumber: model.getPositionAt(reference.start).lineNumber,
						startColumn: model.getPositionAt(reference.start).column,
						endLineNumber: model.getPositionAt(reference.end).lineNumber,
						endColumn: model.getPositionAt(reference.end).column,
					});
					editor.focus();
				}),
			);
		}
		if (
			content instanceof ElementChatAttachmentWidget ||
			content instanceof SCMHistoryItemAttachmentWidget ||
			content instanceof SCMHistoryItemChangeAttachmentWidget ||
			(content instanceof DefaultChatAttachmentWidget && !attachment.resource)
		) {
			this.savedContentWidget = content;
		}
		if (this.savedContentWidget) {
			this._register(this.savedContentWidget.onDidOpen(() => openSaved?.()));
			this._register(editor.onDidChangeCursorSelection(() => this.savedContentWidget?.hideHover()));
		}
		this.widgets = [this.addContentWidget(host)];
	}

	get opensSavedContent(): boolean {
		return this.savedContentWidget !== undefined;
	}

	get widthInEm(): number {
		const font = this.editor.getOption(EditorOption.fontInfo);
		return (
			(this.attachmentWidget.element.getBoundingClientRect().width ||
				this.attachment.name.length * font.typicalHalfwidthCharacterWidth + 28) / font.fontSize
		);
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

/** Generic sources keep their original navigation; source-less contexts expose their saved-content intent. */
export class DefaultChatAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly contentHover: AttachmentContentHover;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IOpenerService opener: IOpenerService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const control = this._register(
			createSourceAttachmentControl(attachment, getDefaultAttachmentIcon(attachment.kind), container),
		);
		this.element = control.element;
		this.contentHover = control.contentHover;
		if (attachment.kind === 'symbol' && isAttachmentResource(attachment.resource)) {
			this._register(
				instantiation.createInstance(
					AttachmentResourceActions,
					control.element,
					control.source,
					attachment.resource,
					false,
					MenuId.ChatInputSymbolAttachmentContext,
				),
			);
		}
		this._register(
			wireSourceAttachmentActions(
				this,
				control.element,
				control.source,
				attachment,
				options,
				() => {
					const resource = attachment.resource;
					if (!resource) return;
					if (resource.scheme === Schemas.internal && resource.authority === 'search-results') {
						return commands.executeCommand(FOCUS_SEARCH_COMMAND_ID);
					}
					return opener.open(resource, {
						fromUserGesture: true,
						openExternal: resource.scheme === Schemas.https || resource.scheme === Schemas.http,
					});
				},
				this.opened,
				this.deleted,
				notifications,
			),
		);
	}

	setHoverMessage(message: MarkdownString): void {
		this.contentHover.update(message);
	}

	hideHover(): void {
		this.contentHover.hide();
	}
}

function getDefaultAttachmentIcon(kind: string): Icon {
	switch (kind) {
		case 'searchResults':
			return Lxicon.search;
		case 'symbol':
			return Lxicon.code;
		case 'debug':
			return Lxicon.bug;
		case 'issue':
			return Lxicon.circleLarge;
		case 'pullRequest':
			return Lxicon.gitPullRequest;
		default:
			return Lxicon.file;
	}
}

/** Element markup is captured text. Its source page is a separate action, never a live DOM lookup. */
export class ElementChatAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly contentHover: AttachmentContentHover;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IOpenerService opener: IOpenerService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.code, container));
		this.element = control.element;
		this.contentHover = control.contentHover;
		const resource = attachment.resource;
		if (resource && (resource.scheme === Schemas.https || resource.scheme === Schemas.http)) {
			addAttachmentSourceAction(
				control,
				attachment,
				localize('chat.context.openElementSource', 'Open source page for {0}', attachment.name),
				Lxicon.linkExternal,
				() => opener.open(resource, { fromUserGesture: true, openExternal: true }),
				notifications,
			);
		}
		this._register(
			wireAttachmentActions(
				this.element,
				control.source,
				attachment.name,
				options,
				() => this.opened.fire(),
				event => this.deleted.fire(event),
			),
		);
	}

	setHoverMessage(message: MarkdownString): void {
		this.contentHover.update(message);
	}

	hideHover(): void {
		this.contentHover.hide();
	}
}

/** Commit identity belongs to SCM; captured content continues to belong to the input snapshot owner. */
export class SCMHistoryItemAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly contentHover: AttachmentContentHover;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.gitCommit, container));
		this.element = control.element;
		this.contentHover = control.contentHover;
		const source = SCMHistoryItemUri.fromUri(attachment.resource);
		if (source && source.path === undefined) {
			addAttachmentSourceAction(
				control,
				attachment,
				localize('chat.context.openCommitSource', 'Open commit changes for {0}', attachment.name),
				Lxicon.diffMultiple1,
				token =>
					commands.executeCommand(
						'workbench.scm.action.graph.viewChanges',
						attachment.resource,
						attachment.name,
						token,
					),
				notifications,
			);
		}
		this._register(
			wireAttachmentActions(
				this.element,
				control.source,
				attachment.name,
				options,
				() => this.opened.fire(),
				event => this.deleted.fire(event),
			),
		);
	}

	setHoverMessage(message: MarkdownString): void {
		this.contentHover.update(message);
	}

	hideHover(): void {
		this.contentHover.hide();
	}
}

/** A history file source opens its captured revision through SCM, never the current working file. */
export class SCMHistoryItemChangeAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly contentHover: AttachmentContentHover;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.gitCommit, container));
		this.element = control.element;
		this.contentHover = control.contentHover;
		const source = SCMHistoryItemUri.fromUri(attachment.resource);
		if (source?.path) {
			addAttachmentSourceAction(
				control,
				attachment,
				localize('chat.context.openHistoryFileSource', 'Open revision file for {0}', attachment.name),
				Lxicon.goToFile,
				token =>
					commands.executeCommand(
						'workbench.scm.action.graph.openFile',
						attachment.resource,
						attachment.name,
						token,
					),
				notifications,
			);
		}
		this._register(
			wireAttachmentActions(
				this.element,
				control.source,
				attachment.name,
				options,
				() => this.opened.fire(),
				event => this.deleted.fire(event),
			),
		);
	}

	setHoverMessage(message: MarkdownString): void {
		this.contentHover.update(message);
	}

	hideHover(): void {
		this.contentHover.hide();
	}
}

/** Secondary navigation does not publish a captured-content intent or install another deletion owner. */
function addAttachmentSourceAction(
	control: DisposableStore & { element: HTMLElement },
	attachment: ChatContextAttachment,
	label: string,
	icon: Icon,
	activate: (token: CancellationToken) => unknown,
	notifications: INotificationService,
): void {
	const token = cancelOnDispose(control);
	const source = control.add(
		new Button(control.element, {
			...defaultButtonStyles,
			label,
			title: label,
			icon,
			iconOnly: true,
			size: 'small',
			presentation: 'quiet',
		}),
	);
	source.domNode.classList.add('ash-chat-attachment-origin');
	let opening = false;
	control.add(
		source.onDidClick(() => {
			if (control.isDisposed || opening) return;
			opening = true;
			void Promise.resolve()
				.then(() => {
					if (!token.isCancellationRequested) return activate(token);
				})
				.catch(error => {
					if (!token.isCancellationRequested)
						notifications.error(
							localize(
								'chat.context.openFailed',
								'Could not open {0}: {1}',
								attachment.name,
								String(error),
							),
						);
				})
				.finally(() => {
					opening = false;
				});
		}),
	);
}

/** An instruction is an authorized catalog reference; opening it never resolves its backend path as text. */
export class PromptFileAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IOpenerService opener: IOpenerService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.book, container));
		this.element = control.element;
		if (isAttachmentResource(attachment.resource)) {
			this._register(
				instantiation.createInstance(
					AttachmentResourceActions,
					control.element,
					control.source,
					attachment.resource,
					false,
					MenuId.ChatInputResourceAttachmentContext,
				),
			);
		}
		control.source.disabled = !attachment.resource;
		this._register(
			wireSourceAttachmentActions(
				this,
				control.element,
				control.source,
				attachment,
				options,
				() =>
					attachment.resource
						? opener.open(attachment.resource, { fromUserGesture: true, openExternal: false })
						: undefined,
				this.opened,
				this.deleted,
				notifications,
			),
		);
	}
}

/** Tool references only navigate to their owner; catalog selection and execution remain with the original services. */
export class ToolSetOrToolItemAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.settings, container));
		this.element = control.element;
		this._register(
			wireSourceAttachmentActions(
				this,
				control.element,
				control.source,
				attachment,
				options,
				() => commands.executeCommand(OpenSettingsCommandId, { section: 'tools' }),
				this.opened,
				this.deleted,
				notifications,
			),
		);
	}
}

/** Derived preview DOM belongs to its native control, never to the reference or snapshot model. */
class AttachmentContentHover extends Disposable {
	private readonly resources = this._register(new MutableDisposable<DisposableStore>());
	private control: IManagedHover | undefined;
	private message: string | undefined;

	constructor(
		private readonly target: HTMLElement,
		private readonly clearTitle?: () => void,
	) {
		super();
	}

	update(message: MarkdownString): void {
		const identity = JSON.stringify(message);
		// Layout and selection can re-project the same snapshot without retiring a visible hover.
		if (this.isDisposed || identity === this.message) return;
		const resources = new DisposableStore();
		this.resources.value = resources;
		this.clearTitle?.();
		const content = resources.add(renderMarkdown(message, { ownerDocument: this.target.ownerDocument }));
		this.control = resources.add(getHoverDelegate().setupHover({ target: this.target, content: content.element }));
		this.message = identity;
	}

	hide(): void {
		this.control?.hide();
	}
}

/** Label layout and hover lifetime are shared; source policies and open/delete events remain widget-owned. */
function createSourceAttachmentControl(attachment: ChatContextAttachment, icon: Icon, container: HTMLElement) {
	const resources = new DisposableStore();
	const element = h(container.ownerDocument, 'div');
	element.className = 'ash-chat-attachment-chip';
	element.dataset.attachmentKind = attachment.kind;
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', attachment.name);
	container.append(element);
	resources.add(toDisposable(() => element.remove()));
	const source = resources.add(
		new Button(element, {
			...defaultButtonStyles,
			label: attachment.name,
			icon,
			ariaLabel: localize('chat.context.open', 'Open {0}', attachment.name),
			title: attachment.resource ? `${attachment.name}\n${attachment.resource.toString(true)}` : attachment.name,
			size: 'small',
			presentation: 'quiet',
		}),
	);
	source.domNode.classList.add('ash-chat-attachment-source');
	const contentHover = resources.add(new AttachmentContentHover(source.domNode, () => source.setTitle(undefined)));
	return Object.assign(resources, { element, source: source.domNode, contentHover });
}

/** A retired or still-opening source cannot navigate again or publish a late result. */
function wireSourceAttachmentActions(
	owner: Disposable,
	element: HTMLElement,
	source: HTMLButtonElement,
	attachment: ChatContextAttachment,
	options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
	activate: () => unknown,
	opened: Emitter<void>,
	deleted: Emitter<globalThis.Event>,
	notifications: INotificationService,
): DisposableStore {
	let opening = false;
	return wireAttachmentActions(
		element,
		source,
		attachment.name,
		options,
		() => {
			if (owner.isDisposed || opening || source.disabled) return;
			opening = true;
			void Promise.resolve()
				.then(() => {
					if (!owner.isDisposed) return activate();
				})
				.then(
					() => {
						if (!owner.isDisposed) opened.fire();
					},
					error => {
						if (!owner.isDisposed)
							notifications.error(
								localize(
									'chat.context.openFailed',
									'Could not open {0}: {1}',
									attachment.name,
									String(error),
								),
							);
					},
				)
				.finally(() => {
					opening = false;
				});
		},
		event => deleted.fire(event),
	);
}

/** Owns a file label, theme icons and hover. Opening delegates to the input's saved-content owner. */
export class FileAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;
	private readonly contentHover: AttachmentContentHover;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IResourceIconRenderer resourceIcons: IResourceIconRenderer,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		const chip = (this.element = h(document, 'div'));
		chip.className = 'ash-chat-code-reference-chip';
		chip.setAttribute('role', 'group');
		chip.setAttribute('aria-label', attachment.name);
		container.append(chip);
		this._register(toDisposable(() => chip.remove()));
		const source = h(document, 'button');
		this.contentHover = this._register(new AttachmentContentHover(source));
		source.type = 'button';
		source.className = 'ash-chat-code-reference-source';
		source.setAttribute('aria-label', localize('chat.context.open', 'Open {0}', attachment.name));
		chip.append(source);
		if (isAttachmentResource(attachment.resource)) {
			this._register(
				instantiation.createInstance(
					AttachmentResourceActions,
					chip,
					source,
					attachment.resource,
					attachment.kind === 'directory',
					MenuId.ChatInputResourceAttachmentContext,
				),
			);
		}
		const label = this._register(new IconLabel(source, { label: attachment.name, reserveIconSpace: true }));
		label.labelElement.classList.add('ash-chat-code-reference');
		const renderIcon = () => {
			const resource = attachment.resource;
			const placeholder = !resource || resource.scheme === 'output' || resource.scheme === 'inmemory';
			label.setIcon(
				undefined,
				placeholder
					? undefined
					: target => {
							const glyph = h(document, 'span');
							target.append(glyph);
							if (attachment.kind === 'directory') appendIcon(Lxicon.folder, glyph);
							else if (resourceIcons.getFileIconTheme().hasFileIcons)
								resourceIcons.renderFileIcon(resource, glyph);
							else appendIcon(Lxicon.file, glyph);
						},
				true,
			);
			label.iconElement.classList.add('ash-chat-code-reference-icon');
			label.iconElement.classList.toggle('placeholder', placeholder);
		};
		renderIcon();
		this._register(resourceIcons.onDidChangeResourceIcons(renderIcon));
		if (attachment.kind === 'directory') {
			source.disabled = !attachment.resource;
			this._register(
				wireSourceAttachmentActions(
					this,
					chip,
					source,
					attachment,
					options,
					() =>
						attachment.resource
							? commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, attachment.resource)
							: undefined,
					this.opened,
					this.deleted,
					notifications,
				),
			);
		} else {
			this._register(
				wireAttachmentActions(
					chip,
					source,
					attachment.name,
					options,
					() => this.opened.fire(),
					event => this.deleted.fire(event),
				),
			);
		}
	}

	setHoverMessage(message: MarkdownString): void {
		this.contentHover.update(message);
	}

	hideHover(): void {
		this.contentHover.hide();
	}
}

/** A resource control owns only its transient menu and drag identity, never an editor or snapshot. */
class AttachmentResourceActions extends Disposable {
	constructor(
		element: HTMLElement,
		source: HTMLElement,
		resource: URI,
		isDirectory: boolean,
		menuId: MenuId,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService menus: IContextMenuService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const context = this._register(contextKeys.createScoped(element));
		ResourceContext.bindTo(context).set(resource.toString());
		ResourceSetContext.bindTo(context).set(true);
		ResourceSchemeContext.bindTo(context).set(resource.scheme);
		ResourcePathContext.bindTo(context).set(resource.path);
		ResourceFilenameContext.bindTo(context).set(basename(resource));
		ResourceDirnameContext.bindTo(context).set(dirname(resource).path);
		ResourceExtensionContext.bindTo(context).set(extname(resource.path));
		ExplorerFolderContext.bindTo(context).set(isDirectory);
		MultipleEditorsSelectedInGroupContext.bindTo(context).set(false);
		const token = cancelOnDispose(this._register(new DisposableStore()));
		const showMenu = (event: MouseEvent | KeyboardEvent) => {
			if (event.defaultPrevented || token.isCancellationRequested) return;
			event.preventDefault();
			event.stopPropagation();
			const target = event.target as HTMLElement;
			const anchor = 'clientX' in event ? source : (target.closest<HTMLElement>('button') ?? source);
			anchor.focus({ preventScroll: true });
			menus.showContextMenu({
				menuId,
				contextKeyService: context,
				menuActionOptions: { arg: resource },
				getAnchor: () =>
					'clientX' in event
						? { x: event.clientX, y: event.clientY, targetWindow: element.ownerDocument.defaultView! }
						: anchor,
				autoSelectFirstItem: true,
				cancellationToken: token,
			});
		};
		this._register(addDisposableListener(element, 'contextmenu', showMenu));
		this._register(
			addDisposableListener(element, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) showMenu(event);
			}),
		);
		source.draggable = true;
		this._register(
			toDisposable(() => {
				source.draggable = false;
			}),
		);
		this._register(
			addDisposableListener(source, 'dragstart', event => {
				event.stopPropagation();
				instantiation.invokeFunction(fillEditorsDragData, [{ resource, isDirectory }], event);
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = 'copyLink';
					event.dataTransfer.setDragImage(element, 0, 0);
				}
			}),
		);
	}
}

function isAttachmentResource(resource: URI | undefined): resource is URI {
	return (
		!!resource &&
		(resource.scheme === Schemas.file ||
			isRemoteResource(resource) ||
			resource.scheme === Schemas.untitled ||
			resource.scheme === Schemas.vscodeUserData)
	);
}

/** Displays the image already prepared by the attachment owner; no source resource is reread. */
export class ImageAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IContextViewService contextViews: IContextViewService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		const element = (this.element = h(document, 'div'));
		element.className = 'ash-chat-attachment-chip ash-chat-image-reference-control';
		element.setAttribute('role', 'group');
		element.setAttribute('aria-label', attachment.name);
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		const source = this._register(
			new Button(element, {
				...defaultButtonStyles,
				label: attachment.name,
				ariaLabel: localize('chat.context.previewImage', 'Preview {0}', attachment.name),
				title: localize('chat.context.imageLoading', 'Loading preview: {0}', attachment.name),
				icon: Lxicon.image,
				enabled: false,
				size: 'small',
				presentation: 'quiet',
			}),
		);
		source.domNode.classList.add('ash-chat-attachment-source');
		if (isAttachmentResource(attachment.resource)) {
			this._register(
				instantiation.createInstance(
					AttachmentResourceActions,
					element,
					source.domNode,
					attachment.resource,
					false,
					MenuId.ChatInputResourceAttachmentContext,
				),
			);
		}
		const thumbnail = h(document, 'img');
		thumbnail.draggable = false;
		thumbnail.alt = attachment.name;
		thumbnail.hidden = true;
		source.domNode.prepend(thumbnail);
		element.setAttribute('aria-busy', 'true');
		const loading = this._register(new DisposableStore());
		this._register(toDisposable(() => thumbnail.removeAttribute('src')));
		const open = () => {
			if (this.isDisposed || !source.enabled) return;
			const resources = new DisposableStore();
			this.preview.value = resources;
			const frame = createAttachmentPreview(
				attachment,
				source.domNode,
				contextViews,
				resources,
				{
					className: 'ash-chat-image-reference-preview',
					label: localize('chat.context.previewImage', 'Preview {0}', attachment.name),
					closeLabel: localize('chat.context.closeImagePreview', 'Close image preview'),
				},
				() => {
					if (this.preview.value === resources) this.preview.clear();
				},
			);
			const image = h(document, 'img');
			image.alt = attachment.name;
			image.src = thumbnail.src;
			frame.content.append(image);
			if (frame.show()) this.opened.fire();
			else this.preview.clear();
		};
		this._register(
			wireAttachmentActions(element, source.domNode, attachment.name, options, open, event =>
				this.deleted.fire(event),
			),
		);
		const unavailable = () => {
			if (this.isDisposed) return;
			loading.clear();
			thumbnail.removeAttribute('src');
			const message = localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name);
			element.setAttribute('aria-busy', 'false');
			element.setAttribute('aria-label', message);
			source.domNode.setAttribute('aria-label', message);
			source.setTitle(message);
			source.icon = Lxicon.warning;
		};
		loading.add(addDisposableListener(thumbnail, 'error', unavailable));
		loading.add(
			addDisposableListener(thumbnail, 'load', () => {
				if (!thumbnail.naturalWidth) {
					unavailable();
					return;
				}
				loading.clear();
				element.setAttribute('aria-busy', 'false');
				source.setTitle(attachment.name);
				source.icon = undefined;
				thumbnail.hidden = false;
				source.enabled = true;
			}),
		);
		void attachment.resolve().then(context => {
			if (this.isDisposed) return;
			if (!/^data:image\/(png|jpeg|gif|webp);base64,/u.test(context.content)) {
				unavailable();
				return;
			}
			// Captured bytes can outlive their original source. A data URL alone does not
			// establish that the browser can display them; native loading gates preview.
			thumbnail.src = context.content;
		}, unavailable);
	}
}

/** Owns frozen terminal rendering and the optional action back to its original terminal. */
export class TerminalCommandAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());
	private opening = false;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IContextViewService contextViews: IContextViewService,
		@IInstantiationService instantiation: IInstantiationService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		const element = (this.element = h(document, 'div'));
		element.className = 'ash-chat-attachment-chip ash-chat-terminal-attachment';
		element.setAttribute('role', 'group');
		element.setAttribute('aria-label', attachment.name);
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		const resource = attachment.resource;
		const terminalId =
			resource?.scheme === Schemas.internal && resource.authority === 'terminal'
				? new URLSearchParams(resource.query).get('id')
				: undefined;
		const snapshot = attachment.terminalSnapshot;
		const source = this._register(
			new Button(element, {
				...defaultButtonStyles,
				label: attachment.name,
				ariaLabel: snapshot
					? localize('terminal.chat.preview', 'Preview terminal snapshot')
					: localize('chat.context.open', 'Open {0}', attachment.name),
				icon: Lxicon.terminal,
				enabled: !!(snapshot || terminalId),
				size: 'small',
				presentation: 'quiet',
			}),
		);
		source.domNode.classList.add('ash-chat-attachment-source');
		const openSource = async () => {
			if (this.isDisposed || this.opening || !terminalId) return;
			this.opening = true;
			try {
				await commands.executeCommand(TerminalCommandId.Focus, terminalId);
				if (!this.isDisposed) this.opened.fire();
			} catch (error) {
				if (!this.isDisposed)
					notifications.error(
						localize('chat.context.openFailed', 'Could not open {0}: {1}', attachment.name, String(error)),
					);
			} finally {
				this.opening = false;
			}
		};
		const open = () => {
			if (this.isDisposed) return;
			if (!snapshot) {
				void openSource();
				return;
			}
			const resources = new DisposableStore();
			this.preview.value = resources;
			try {
				const frame = createAttachmentPreview(
					attachment,
					source.domNode,
					contextViews,
					resources,
					{
						className: 'ash-chat-terminal-reference-preview',
						label: localize('terminal.chat.previewLabel', 'Saved terminal output: {0}', attachment.name),
						closeLabel: localize('terminal.chat.previewClose', 'Close terminal preview'),
					},
					() => {
						if (this.preview.value === resources) this.preview.clear();
					},
				);
				const screen = h(document, 'div');
				screen.className = 'ash-chat-terminal-preview-screen';
				frame.content.append(screen);
				const mirror = resources.add(instantiation.createInstance(DetachedTerminalSnapshotMirror, screen));
				if (terminalId) {
					const original = resources.add(
						new Button(frame.header, {
							...defaultButtonStyles,
							label: localize('chat.context.open', 'Open {0}', attachment.name),
							icon: Lxicon.terminal,
							iconOnly: true,
							size: 'small',
							presentation: 'quiet',
						}),
					);
					resources.add(
						original.onDidClick(() => {
							this.preview.clear();
							void openSource();
						}),
					);
				}
				if (!frame.show()) {
					this.preview.clear();
					return;
				}
				this.opened.fire();
				// The mirror receives only frozen text and geometry, after its dialog is laid out.
				void mirror.render(snapshot).catch(() => {
					if (!resources.isDisposed)
						notifications.error(
							localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name),
						);
				});
			} catch {
				this.preview.clear();
				if (!this.isDisposed)
					notifications.error(
						localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name),
					);
			}
		};
		this._register(
			wireAttachmentActions(element, source.domNode, attachment.name, options, open, event =>
				this.deleted.fire(event),
			),
		);
	}
}

/** Owns the session chip's actions; the referenced conversation and captured content are borrowed. */
export class ChatReferenceAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;
	private opening = false;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		const element = (this.element = h(document, 'div'));
		element.className = 'ash-chat-reference-attachment';
		element.setAttribute('role', 'group');
		element.setAttribute('aria-label', attachment.name);
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		const resource = attachment.resource;
		const parameters =
			resource?.scheme === Schemas.internal && resource.authority === 'chat-session'
				? new URLSearchParams(resource.query)
				: undefined;
		const sessionId = parameters?.get('sessionId');
		const threadId = parameters?.get('threadId');
		const source = this._register(
			new Button(element, {
				...defaultButtonStyles,
				label: attachment.name,
				ariaLabel: localize('chat.context.open', 'Open {0}', attachment.name),
				enabled: !!(sessionId && threadId),
				size: 'small',
				presentation: 'quiet',
			}),
		);
		source.domNode.classList.add('ash-chat-reference-attachment-source');
		const open = async () => {
			if (this.isDisposed || this.opening || !sessionId || !threadId) return;
			this.opening = true;
			try {
				await navigation.openConversation(sessionId, threadId);
				if (!this.isDisposed) this.opened.fire();
			} catch (error) {
				if (!this.isDisposed)
					notifications.error(
						localize('chat.context.openFailed', 'Could not open {0}: {1}', attachment.name, String(error)),
					);
			} finally {
				this.opening = false;
			}
		};
		this._register(
			wireAttachmentActions(
				element,
				source.domNode,
				attachment.name,
				options,
				() => {
					void open();
				},
				event => this.deleted.fire(event),
			),
		);
	}
}

/** Native controls own their keys even while the text caret remains at another attachment. */
function wireAttachmentActions(
	element: HTMLElement,
	source: HTMLElement,
	name: string,
	options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
	open: () => void,
	remove: (event: globalThis.Event) => void,
): DisposableStore {
	const resources = new DisposableStore();
	resources.add(addDisposableListener(source, 'click', open));
	resources.add(
		addDisposableListener(element, 'click', event => {
			if (event.target === element) open();
		}),
	);
	resources.add(
		addDisposableListener(element, 'keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
			if (options.supportsDeletion && (event.key === 'Delete' || event.key === 'Backspace')) {
				event.preventDefault();
				event.stopPropagation();
				remove(event);
			}
		}),
	);
	if (options.supportsDeletion) {
		const button = resources.add(
			new Button(element, {
				...defaultButtonStyles,
				label: localize('chat.attach.remove', 'Remove {0}', name),
				icon: Lxicon.close,
				iconOnly: true,
				size: 'small',
				presentation: 'quiet',
			}),
		);
		button.domNode.classList.add('ash-chat-attachment-remove');
		resources.add(button.onDidClick(remove));
		resources.add(
			addDisposableListener(element, 'auxclick', event => {
				if (event.button !== 1) return;
				event.preventDefault();
				event.stopPropagation();
				remove(event);
			}),
		);
		if (options.shouldFocusClearButton) button.focus();
	}
	return resources;
}

/** Dialog chrome is shared; each widget owns its content, pending work and visible lifetime. */
function createAttachmentPreview(
	attachment: ChatContextAttachment,
	anchor: HTMLElement,
	contextViews: IContextViewService,
	resources: DisposableStore,
	options: { className: string; label: string; closeLabel: string },
	onHide: () => void,
): { content: HTMLElement; header: HTMLElement; show(): boolean } {
	const document = anchor.ownerDocument;
	const content = h(document, 'div');
	content.className = `ash-chat-context-reference-preview ${options.className}`;
	content.dataset.attachmentId = attachment.id;
	content.setAttribute('role', 'dialog');
	content.setAttribute('aria-label', options.label);
	const header = h(document, 'div');
	header.className = 'ash-chat-context-reference-preview-header';
	const title = h(document, 'span');
	title.textContent = attachment.name;
	header.append(title);
	content.append(header);
	const close = resources.add(
		new Button(header, {
			...defaultButtonStyles,
			label: options.closeLabel,
			icon: Lxicon.close,
			iconOnly: true,
			size: 'small',
			presentation: 'quiet',
		}),
	);
	resources.add(close.onDidClick(() => contextViews.hide()));
	let visible = false;
	resources.add(
		toDisposable(() => {
			if (visible) contextViews.hide();
		}),
	);
	return {
		content,
		header,
		show: () => {
			// Alt+Enter starts at the text caret; preview dismissal returns to its native source control.
			anchor.focus({ preventScroll: true });
			visible = contextViews.show({
				anchor,
				content,
				presentation: 'dialog',
				focusRestore: ContextViewFocusRestore.Previous,
				onHide: () => {
					visible = false;
					onHide();
				},
			});
			if (visible) close.focus();
			return visible;
		},
	};
}
