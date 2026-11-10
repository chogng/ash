import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { DetachedTerminalSnapshotMirror } from '../../../terminal/browser/chatTerminalCommandMirror.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import './chatAttachmentWidgets.css';
import { h, addDisposableListener, getWindow } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../../files/browser/fileConstants.js';
import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { FOCUS_SEARCH_COMMAND_ID } from '../../../search/common/constants.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { ContextViewFocusRestore } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { isDarkColorScheme } from '../../../../../platform/theme/common/theme.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { cancelOnDispose, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { SCMHistoryItemUri } from '../../../scm/common/history.js';
import type { Icon } from '../../../../../base/common/icon.js';
import type { IChatAttachmentWidgetInstance } from './chatAttachmentWidgetRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import {
	ResourceContext, ResourceSchemeContext, ResourceSetContext, ResourcePathContext,
	ResourceFilenameContext, ResourceDirnameContext, ResourceExtensionContext, MultipleEditorsSelectedInGroupContext,
} from '../../../../common/contextkeys.js';
import { ExplorerFolderContext } from '../../../files/common/files.js';
import { fillEditorsDragData } from '../../../../browser/dnd.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { extname } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { ImageViewer } from '../../../mediaPreview/browser/imageViewer.js';
import { mediaImageFileName, saveMediaImageAs } from '../../../mediaPreview/browser/mediaPreviewSaveAs.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerService.js';
import { encodeImageBlobAsPng } from '../../../mediaPreview/browser/imageEncoder.js';
import { ImageAnnotation } from '../../../mediaPreview/browser/imageAnnotation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';

/** Generic sources keep their original navigation; source-less contexts expose their saved-content intent. */
export class DefaultChatAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly contentHover: AttachmentContentHover;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;
	private readonly providerTooltip: string | undefined;

	constructor(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
		@IOpenerService opener: IOpenerService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment,
			ThemeIcon.isThemeIcon(attachment.iconPath) ? attachment.iconPath : getDefaultAttachmentIcon(attachment.kind), container, theme));
		this.element = control.element;
		this.contentHover = control.contentHover;
		this.providerTooltip = attachment.tooltip?.value;
		if (this.providerTooltip !== undefined) this.contentHover.update(new MarkdownString(this.providerTooltip));
		if (attachment.kind === 'symbol' && isAttachmentResource(attachment.resource)) {
			this._register(instantiation.createInstance(AttachmentResourceActions, control.element, control.source, attachment.resource, false, MenuId.ChatInputSymbolAttachmentContext));
		}
		this._register(wireSourceAttachmentActions(this, control.element, control.source, attachment, options, () => {
			if (attachment.open) return attachment.open();
			const resource = attachment.resource;
			if (!resource) return;
			if (resource.scheme === Schemas.internal && resource.authority === 'search-results') {
				return commands.executeCommand(FOCUS_SEARCH_COMMAND_ID);
			}
			return opener.open(resource, { fromUserGesture: true, openExternal: resource.scheme === Schemas.https || resource.scheme === Schemas.http });
		}, this.opened, this.deleted, notifications));
	}

	setHoverMessage(message: MarkdownString): void {
		this.contentHover.update(this.providerTooltip === undefined ? message : new MarkdownString(this.providerTooltip));
	}

	hideHover(): void {
		this.contentHover.hide();
	}

}

function getDefaultAttachmentIcon(kind: string): Icon {
	switch (kind) {
		case 'searchResults': return Lxicon.search;
		case 'symbol': return Lxicon.code;
		case 'debug': return Lxicon.bug;
		case 'issue': return Lxicon.issues;
		case 'transcriptContext':
		case 'pullRequest': return Lxicon.gitPullRequest;
		default: return Lxicon.file;
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
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
			addAttachmentSourceAction(control, attachment, localize('chat.context.openElementSource', 'Open source page for {0}', attachment.name), Lxicon.linkExternal,
				() => opener.open(resource, { fromUserGesture: true, openExternal: true }), notifications);
		}
		this._register(wireAttachmentActions(this.element, control.source, attachment.name, options, () => this.opened.fire(), event => this.deleted.fire(event)));
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
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
			addAttachmentSourceAction(control, attachment, localize('chat.context.openCommitSource', 'Open commit changes for {0}', attachment.name), Lxicon.diffMultiple1,
				token => commands.executeCommand('workbench.scm.action.graph.viewChanges', attachment.resource, attachment.name, token), notifications);
		}
		this._register(wireAttachmentActions(this.element, control.source, attachment.name, options, () => this.opened.fire(), event => this.deleted.fire(event)));
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
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
			addAttachmentSourceAction(control, attachment, localize('chat.context.openHistoryFileSource', 'Open revision file for {0}', attachment.name), Lxicon.goToFile,
				token => commands.executeCommand('workbench.scm.action.graph.openFile', attachment.resource, attachment.name, token), notifications);
		}
		this._register(wireAttachmentActions(this.element, control.source, attachment.name, options, () => this.opened.fire(), event => this.deleted.fire(event)));
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
	control: DisposableStore & { element: HTMLElement; },
	attachment: ChatContextAttachment,
	label: string,
	icon: Icon,
	activate: (token: CancellationToken) => unknown,
	notifications: INotificationService,
): void {
	const token = cancelOnDispose(control);
	const source = control.add(new Button(control.element, { ...defaultButtonStyles, label, title: label, icon, iconOnly: true, size: 'small', presentation: 'quiet' }));
	source.domNode.classList.add('ash-chat-attachment-origin');
	let opening = false;
	control.add(source.onDidClick(() => {
		if (control.isDisposed || opening) return;
		opening = true;
		void Promise.resolve().then(() => {
			if (!token.isCancellationRequested) return activate(token);
		}).catch(error => {
			if (!token.isCancellationRequested) notifications.error(localize('chat.context.openFailed', 'Could not open {0}: {1}', attachment.name, String(error)));
		}).finally(() => { opening = false; });
	}));
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
		@IOpenerService opener: IOpenerService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.book, container));
		this.element = control.element;
		if (isAttachmentResource(attachment.resource)) {
			this._register(instantiation.createInstance(AttachmentResourceActions,
				control.element, control.source, attachment.resource, false, MenuId.ChatInputResourceAttachmentContext));
		}
		control.source.disabled = !attachment.resource;
		this._register(wireSourceAttachmentActions(this, control.element, control.source, attachment, options,
			() => attachment.resource ? opener.open(attachment.resource, { fromUserGesture: true, openExternal: false }) : undefined,
			this.opened, this.deleted, notifications));
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const control = this._register(createSourceAttachmentControl(attachment, Lxicon.settings, container));
		this.element = control.element;
		this._register(wireSourceAttachmentActions(this, control.element, control.source, attachment, options,
			() => commands.executeCommand(OpenSettingsCommandId, { section: 'tools' }),
			this.opened, this.deleted, notifications));
	}
}

/** Derived preview DOM belongs to its native control, never to the reference or snapshot model. */
class AttachmentContentHover extends Disposable {
	private readonly resources = this._register(new MutableDisposable<DisposableStore>());
	private control: IManagedHover | undefined;
	private message: string | undefined;

	constructor(private readonly target: HTMLElement, private readonly clearTitle?: () => void) {
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
function createSourceAttachmentControl(attachment: ChatContextAttachment, icon: Icon, container: HTMLElement, theme?: IThemeService) {
	const resources = new DisposableStore();
	const element = h(container.ownerDocument, 'div');
	element.className = 'ash-chat-attachment-chip';
	element.dataset.attachmentKind = attachment.kind;
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', attachment.name);
	container.append(element);
	resources.add(toDisposable(() => element.remove()));
	const imageIcon = attachment.iconPath && !ThemeIcon.isThemeIcon(attachment.iconPath) ? attachment.iconPath : undefined;
	const source = resources.add(new Button(element, {
		...defaultButtonStyles, label: imageIcon ? '' : attachment.name, icon: imageIcon ? undefined : icon,
		ariaLabel: localize('chat.context.open', 'Open {0}', attachment.name),
		title: attachment.resource ? `${attachment.name}\n${attachment.resource.toString(true)}` : attachment.name,
		size: 'small', presentation: 'quiet',
	}));
	if (imageIcon && theme) {
		const label = resources.add(new IconLabel(source.domNode, { label: attachment.name }));
		const render = (): void => {
			let resource: URI;
			if (URI.isUri(imageIcon)) resource = imageIcon;
			else resource = isDarkColorScheme(theme.getColorTheme().colorScheme) ? imageIcon.dark : imageIcon.light;
			label.setIcon(undefined, undefined, false, false, resource);
		};
		render();
		resources.add(theme.onDidColorThemeChange(render));
	}
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
	options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
	activate: () => unknown,
	opened: Emitter<void>,
	deleted: Emitter<globalThis.Event>,
	notifications: INotificationService,
): DisposableStore {
	let opening = false;
	return wireAttachmentActions(element, source, attachment.name, options, () => {
		if (owner.isDisposed || opening || source.disabled) return;
		opening = true;
		void Promise.resolve().then(() => {
			if (!owner.isDisposed) return activate();
		}).then(() => {
			if (!owner.isDisposed) opened.fire();
		}, error => {
			if (!owner.isDisposed) notifications.error(localize('chat.context.openFailed', 'Could not open {0}: {1}', attachment.name, String(error)));
		}).finally(() => { opening = false; });
	}, event => deleted.fire(event));
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
		@IResourceIconRenderer resourceIcons: IResourceIconRenderer,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		const chip = this.element = h(document, 'div');
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
			this._register(instantiation.createInstance(AttachmentResourceActions,
				chip, source, attachment.resource, attachment.kind === 'directory', MenuId.ChatInputResourceAttachmentContext));
		}
		const label = this._register(new IconLabel(source, { label: attachment.name, reserveIconSpace: true }));
		label.labelElement.classList.add('ash-chat-code-reference');
		const renderIcon = () => {
			const resource = attachment.resource;
			const placeholder = !resource || resource.scheme === 'output' || resource.scheme === 'inmemory';
			label.setIcon(undefined, placeholder ? undefined : target => {
				const glyph = h(document, 'span');
				target.append(glyph);
				if (attachment.kind === 'directory') appendIcon(Lxicon.folder, glyph);
				else if (resourceIcons.getFileIconTheme().hasFileIcons) resourceIcons.renderFileIcon(resource, glyph);
				else appendIcon(Lxicon.file, glyph);
			}, true);
			label.iconElement.classList.add('ash-chat-code-reference-icon');
			label.iconElement.classList.toggle('placeholder', placeholder);
		};
		renderIcon();
		this._register(resourceIcons.onDidChangeResourceIcons(renderIcon));
		if (attachment.kind === 'directory') {
			source.disabled = !attachment.resource;
			this._register(wireSourceAttachmentActions(this, chip, source, attachment, options,
				() => attachment.resource ? commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, attachment.resource) : undefined,
				this.opened, this.deleted, notifications));
		} else {
			this._register(wireAttachmentActions(chip, source, attachment.name, options, () => this.opened.fire(), event => this.deleted.fire(event)));
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
			const anchor = 'clientX' in event ? source : target.closest<HTMLElement>('button') ?? source;
			anchor.focus({ preventScroll: true });
			menus.showContextMenu({
				menuId, contextKeyService: context, menuActionOptions: { arg: resource },
				getAnchor: () => 'clientX' in event
					? { x: event.clientX, y: event.clientY, targetWindow: element.ownerDocument.defaultView! }
					: anchor,
				autoSelectFirstItem: 'key' in event, cancellationToken: token,
			});
		};
		this._register(addDisposableListener(element, 'contextmenu', showMenu));
		this._register(addDisposableListener(element, 'keydown', event => {
			if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) showMenu(event);
		}));
		source.draggable = true;
		this._register(toDisposable(() => { source.draggable = false; }));
		this._register(addDisposableListener(source, 'dragstart', event => {
			event.stopPropagation();
			instantiation.invokeFunction(fillEditorsDragData, [{ resource, isDirectory }], event);
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'copyLink';
				event.dataTransfer.setDragImage(element, 0, 0);
			}
		}));
	}
}

function isAttachmentResource(resource: URI | undefined): resource is URI {
	return !!resource && (resource.scheme === Schemas.file || isRemoteResource(resource) || resource.scheme === Schemas.untitled || resource.scheme === Schemas.vscodeUserData);
}

interface ImageAttachment {
	readonly id: string;
	readonly name: string;
	readonly resource?: URI;
	resolve(): Promise<{ readonly content: Blob | string | undefined; }>;
}

export interface IChatImageAnnotationTarget {
	readonly signal: AbortSignal;
	attach(file: File, signal: AbortSignal): Promise<void>;
	focus(): void;
}

/** Displays the image supplied by the attachment owner in either input presentation. */
export class ImageAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {
	readonly element: HTMLElement;
	private readonly previewResolved = this._register(new Emitter<boolean>());
	readonly onDidResolvePreview = this.previewResolved.event;
	private readonly deleted = this._register(new Emitter<globalThis.Event>());
	readonly onDidDelete = this.deleted.event;
	private readonly opened = this._register(new Emitter<void>());
	readonly onDidOpen = this.opened.event;
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());
	private readonly thumbnailRemove?: Button;

	constructor(
		attachment: ImageAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; imagePresentation?: 'inline' | 'thumbnail'; imageAnnotationTarget?: () => IChatImageAnnotationTarget | undefined; },
		container: HTMLElement,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		const tile = options.imagePresentation === 'thumbnail';
		const element = this.element = h(document, 'div');
		element.className = tile ? 'ash-chat-image-attachment-thumbnail' : 'ash-chat-attachment-chip ash-chat-image-reference-control';
		const fallback = tile ? h(document, 'span', { className: 'ash-chat-image-attachment-name' }, attachment.name) : undefined;
		if (fallback) element.append(fallback);
		else {
			element.setAttribute('role', 'group');
			element.setAttribute('aria-label', attachment.name);
			element.setAttribute('aria-busy', 'true');
		}
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		const source = this._register(new Button(element, {
			...defaultButtonStyles,
			label: tile ? '' : attachment.name,
			ariaLabel: localize('chat.context.previewImage', 'Preview {0}', attachment.name),
			title: localize('chat.context.imageLoading', 'Loading preview: {0}', attachment.name),
			icon: tile ? undefined : Lxicon.image,
			enabled: false, size: 'small', presentation: 'quiet',
		}));
		source.domNode.classList.add(tile ? 'ash-chat-image-attachment-source' : 'ash-chat-attachment-source');
		source.domNode.hidden = tile;
		if (isAttachmentResource(attachment.resource)) {
			this._register(instantiation.createInstance(AttachmentResourceActions,
				element, source.domNode, attachment.resource, false, MenuId.ChatInputResourceAttachmentContext));
		}
		const thumbnail = h(document, 'img');
		thumbnail.draggable = false;
		thumbnail.alt = tile ? '' : attachment.name;
		thumbnail.hidden = true;
		source.domNode.prepend(thumbnail);
		const loading = this._register(new DisposableStore());
		const objectUrl = this._register(new MutableDisposable());
		this._register(toDisposable(() => thumbnail.removeAttribute('src')));
		let imageContent: Blob | string | undefined;
		const open = () => {
			if (this.isDisposed || !source.enabled || !imageContent) return;
			const image = typeof imageContent === 'string' ? imageDataUrlToBlob(imageContent) : imageContent;
			const resources = new DisposableStore();
			this.preview.value = resources;
			const preview = instantiation.createInstance(ImageAttachmentPreview, attachment, image, thumbnail.src, source.domNode, resources, options.imageAnnotationTarget?.(),
				() => { if (this.preview.value === resources) this.preview.clear(); });
			if (preview.show()) this.opened.fire();
			else this.preview.clear();
		};
		if (tile && options.supportsDeletion) {
			const label = localize('chat.input.removeFile', 'Remove {0}', attachment.name);
			this.thumbnailRemove = new Button(element, {
				...defaultButtonStyles, label, title: label,
				icon: Lxicon.close, iconOnly: true, size: 'small', presentation: 'secondary',
			});
		}
		this._register(wireAttachmentActions(element, source.domNode, attachment.name, options, open, event => this.deleted.fire(event), this.thumbnailRemove));
		const unavailable = () => {
			if (this.isDisposed) return;
			loading.clear();
			thumbnail.removeAttribute('src');
			objectUrl.clear();
			if (!tile) {
				const message = localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name);
				element.setAttribute('aria-busy', 'false');
				element.setAttribute('aria-label', message);
				source.domNode.setAttribute('aria-label', message);
				source.setTitle(message);
				source.icon = Lxicon.warning;
			}
			this.previewResolved.fire(false);
		};
		loading.add(addDisposableListener(thumbnail, 'error', unavailable));
		loading.add(addDisposableListener(thumbnail, 'load', () => {
			if (!thumbnail.naturalWidth) { unavailable(); return; }
			loading.clear();
			if (fallback) {
				fallback.hidden = true;
				element.classList.add('loaded');
			} else {
				element.setAttribute('aria-busy', 'false');
			}
			source.setTitle(attachment.name);
			source.icon = undefined;
			thumbnail.hidden = false;
			source.domNode.hidden = false;
			source.enabled = true;
			this.previewResolved.fire(true);
		}));
		void attachment.resolve().then(({ content }) => {
			if (this.isDisposed) return;
			if (!content || typeof content === 'string' && !/^data:image\/(png|jpeg|gif|webp);base64,/u.test(content)) { unavailable(); return; }
			imageContent = content;
			// Captured bytes can outlive their original source. A data URL alone does not
			// establish that the browser can display them; native loading gates preview.
			if (typeof content === 'string') {
				thumbnail.src = content;
			} else {
				const { URL } = getWindow(element);
				try {
					const url = URL.createObjectURL(content);
					objectUrl.value = toDisposable(() => URL.revokeObjectURL(url));
					thumbnail.src = url;
				} catch {
					unavailable();
				}
			}
		}, unavailable);
	}

	setThumbnailState(pending: boolean, readOnly: boolean): void {
		this.element.classList.toggle('pending', pending);
		if (this.thumbnailRemove) this.thumbnailRemove.enabled = !readOnly;
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
		@IContextViewService contextViews: IContextViewService,
		@IInstantiationService instantiation: IInstantiationService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		const element = this.element = h(document, 'div');
		element.className = 'ash-chat-attachment-chip ash-chat-terminal-attachment';
		element.setAttribute('role', 'group');
		element.setAttribute('aria-label', attachment.name);
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		const resource = attachment.resource;
		const terminalId = resource?.scheme === Schemas.internal && resource.authority === 'terminal' ? new URLSearchParams(resource.query).get('id') : undefined;
		const snapshot = attachment.terminalSnapshot;
		const source = this._register(new Button(element, {
			...defaultButtonStyles,
			label: attachment.name,
			ariaLabel: snapshot ? localize('terminal.chat.preview', 'Preview terminal snapshot') : localize('chat.context.open', 'Open {0}', attachment.name),
			icon: Lxicon.terminal, enabled: !!(snapshot || terminalId), size: 'small', presentation: 'quiet',
		}));
		source.domNode.classList.add('ash-chat-attachment-source');
		const openSource = async () => {
			if (this.isDisposed || this.opening || !terminalId) return;
			this.opening = true;
			try {
				await commands.executeCommand(TerminalCommandId.Focus, terminalId);
				if (!this.isDisposed) this.opened.fire();
			} catch (error) {
				if (!this.isDisposed) notifications.error(localize('chat.context.openFailed', 'Could not open {0}: {1}', attachment.name, String(error)));
			} finally { this.opening = false; }
		};
		const open = () => {
			if (this.isDisposed) return;
			if (!snapshot) { void openSource(); return; }
			const resources = new DisposableStore();
			this.preview.value = resources;
			try {
				const frame = createAttachmentPreview(attachment, source.domNode, contextViews, resources, {
					className: 'ash-chat-terminal-reference-preview',
					label: localize('terminal.chat.previewLabel', 'Saved terminal output: {0}', attachment.name),
					closeLabel: localize('terminal.chat.previewClose', 'Close terminal preview'),
				}, () => { if (this.preview.value === resources) this.preview.clear(); });
				const screen = h(document, 'div');
				screen.className = 'ash-chat-terminal-preview-screen';
				frame.content.append(screen);
				const mirror = resources.add(instantiation.createInstance(DetachedTerminalSnapshotMirror, screen));
				if (terminalId) {
					const original = resources.add(new Button(frame.header, {
						...defaultButtonStyles,
						label: localize('chat.context.open', 'Open {0}', attachment.name),
						icon: Lxicon.terminal, iconOnly: true, size: 'small', presentation: 'quiet',
					}));
					resources.add(original.onDidClick(() => { this.preview.clear(); void openSource(); }));
				}
				if (!frame.show()) { this.preview.clear(); return; }
				this.opened.fire();
				// The mirror receives only frozen text and geometry, after its dialog is laid out.
				void mirror.render(snapshot).catch(() => {
					if (!resources.isDisposed) notifications.error(localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name));
				});
			} catch {
				this.preview.clear();
				if (!this.isDisposed) notifications.error(localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name));
			}
		};
		this._register(wireAttachmentActions(element, source.domNode, attachment.name, options, open, event => this.deleted.fire(event)));
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
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		const element = this.element = h(document, 'div');
		element.className = 'ash-chat-reference-attachment';
		element.setAttribute('role', 'group');
		element.setAttribute('aria-label', attachment.name);
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		const resource = attachment.resource;
		const conversation = resource && LocalChatSessionUri.parse(resource);
		const source = this._register(new Button(element, {
			...defaultButtonStyles,
			label: attachment.name,
			ariaLabel: localize('chat.context.open', 'Open {0}', attachment.name),
			enabled: !!conversation,
			size: 'small',
			presentation: 'quiet',
		}));
		source.domNode.classList.add('ash-chat-reference-attachment-source');
		const open = async () => {
			if (this.isDisposed || this.opening || !conversation) return;
			this.opening = true;
			try {
				await navigation.openConversation(conversation.sessionId, conversation.threadId);
				if (!this.isDisposed) this.opened.fire();
			} catch (error) {
				if (!this.isDisposed) notifications.error(localize('chat.context.openFailed', 'Could not open {0}: {1}', attachment.name, String(error)));
			} finally {
				this.opening = false;
			}
		};
		this._register(wireAttachmentActions(element, source.domNode, attachment.name, options, () => { void open(); }, event => this.deleted.fire(event)));
	}
}

/** Native controls own their keys even while the text caret remains at another attachment. */
function wireAttachmentActions(
	element: HTMLElement,
	source: HTMLElement,
	name: string,
	options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
	open: () => void,
	remove: (event: globalThis.Event) => void,
	removeButton?: Button,
): DisposableStore {
	const resources = new DisposableStore();
	resources.add(addDisposableListener(source, 'click', open));
	resources.add(addDisposableListener(element, 'click', event => { if (event.target === element) open(); }));
	resources.add(addDisposableListener(element, 'keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
		if (options.supportsDeletion && removeButton?.enabled !== false && (event.key === 'Delete' || event.key === 'Backspace')) {
			event.preventDefault();
			event.stopPropagation();
			remove(event);
		}
	}));
	if (options.supportsDeletion) {
		const button = resources.add(removeButton ?? new Button(element, {
			...defaultButtonStyles,
			label: localize('chat.attach.remove', 'Remove {0}', name),
			icon: Lxicon.close, iconOnly: true, size: 'small', presentation: 'quiet',
		}));
		button.domNode.classList.add('ash-chat-attachment-remove');
		resources.add(button.onDidClick(remove));
		resources.add(addDisposableListener(element, 'auxclick', event => {
			if (event.button !== 1 || !button.enabled) return;
			event.preventDefault();
			event.stopPropagation();
			remove(event);
		}));
		if (options.shouldFocusClearButton) button.focus();
	}
	return resources;
}

function imageDataUrlToBlob(source: string): Blob {
	const dataStart = source.indexOf(',') + 1;
	return new Blob([new Uint8Array(decodeBase64(source.slice(dataStart)).buffer)], { type: source.slice(5, source.indexOf(';')) });
}

class ImageAttachmentPreview {
	private readonly frame: ReturnType<typeof createAttachmentPreview>;

	constructor(
		attachment: ImageAttachment,
		image: Blob,
		src: string,
		anchor: HTMLElement,
		resources: DisposableStore,
		target: IChatImageAnnotationTarget | undefined,
		onHide: () => void,
		@IContextViewService contextViews: IContextViewService,
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService notifications: INotificationService,
		@IHostService host: IHostService,
		@IWebWorkerService workers: IWebWorkerService,
	) {
		const frame = this.frame = createAttachmentPreview(attachment, anchor, contextViews, resources, {
			className: 'ash-chat-image-reference-preview',
			label: localize('chat.context.previewImage', 'Preview {0}', attachment.name),
			closeLabel: localize('chat.context.closeImagePreview', 'Close image preview'),
		}, onHide);
		const document = anchor.ownerDocument;
		const viewport = h(document, 'div', { className: 'ash-chat-image-reference-viewport' });
		frame.content.append(viewport);
		const annotation = target && resources.add(new ImageAnnotation(document, src));
		// The dialog and the viewer's context menu use the same popup host.
		const viewer = resources.add(instantiation.createInstance(ImageViewer, viewport, { contextMenu: false, overlay: annotation?.overlay }));
		const lifetime = new AbortController();
		resources.add(toDisposable(() => lifetime.abort()));
		if (target) resources.add(addDisposableListener(target.signal, 'abort', () => contextViews.hide()));
		const read = async () => new Uint8Array(await image.arrayBuffer());
		const name = mediaImageFileName(attachment.name, image.type);
		const actions = h(document, 'div', { className: 'ash-chat-image-reference-actions' });
		frame.header.insertBefore(actions, frame.header.lastElementChild);
		const reportError = (error: unknown) => {
			if (!lifetime.signal.aborted && !isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
		};
		const action = (label: string, icon: Icon | undefined, run: () => void | Promise<void>, presentation: 'quiet' | 'primary' = 'quiet'): Button => {
			const button = resources.add(new Button(actions, {
				...defaultButtonStyles, label, title: label, icon,
				iconOnly: !!icon, size: 'small', presentation
			}));
			resources.add(button.onDidClick(() => { void Promise.resolve().then(run).catch(reportError); }));
			return button;
		};
		const zoom = [
			action(localize('media.image.zoomOut', 'Zoom out'), Lxicon.zoomOut, () => viewer.zoomOut()),
			action(localize('media.image.zoomIn', 'Zoom in'), Lxicon.zoomIn, () => viewer.zoomIn()),
			action(localize('media.image.fit', 'Fit to window'), Lxicon.openInWindow, () => viewer.setScale('fit')),
		];
		for (const button of zoom) button.enabled = false;
		resources.add(viewer.onDidChangeScale(() => { for (const button of zoom) button.enabled = true; }));
		resources.add(viewer.onDidFailCopy(reportError));
		const save = action(localize('chat.context.saveImage', 'Save image'), Lxicon.download,
			() => instantiation.invokeFunction(saveMediaImageAs, image, name, document));
		const openImage = host.openImageInDefaultApp?.bind(host);
		const external = openImage && action(localize('chat.context.openImageInDefaultApp', 'Open in default image app'), Lxicon.openInProduct, async () => {
			const nativeFormat = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.type);
			try { await openImage(await (nativeFormat ? read() : encodeImageBlobAsPng(image, document, workers))); }
			catch (error) { throw new Error(localize('chat.context.openFailed', 'Could not open {0}: {1}', name, String(error)), { cause: error }); }
		});
		if (annotation && target) {
			let editing = false;
			let busy = false;
			const toggle = (active: boolean) => {
				editing = active;
				for (const button of [save, external, draw]) if (button) button.domNode.hidden = active;
				for (const button of [undo, cancel, done]) button.domNode.hidden = !active;
				update();
			};
			const update = () => {
				draw.enabled = viewer.hasImage;
				undo.enabled = editing && annotation.hasStrokes && !busy;
				done.enabled = undo.enabled;
				cancel.enabled = !busy;
			};
			const draw = action(localize('chat.image.annotate', 'Annotate image'), Lxicon.edit, () => {
				if (!viewer.naturalSize) return;
				annotation.start(viewer.naturalSize);
				toggle(true);
				viewer.domNode.focus();
			});
			const undo = action(localize('chat.image.undoStroke', 'Undo stroke'), undefined, () => annotation.undo());
			const cancel = action(localize('chat.image.cancelAnnotation', 'Cancel annotation'), undefined, () => {
				annotation.clear();
				toggle(false);
				draw.focus();
			});
			const done = action(localize('chat.image.doneAnnotating', 'Done annotating'), undefined, async () => {
				if (busy || !annotation.hasStrokes) return;
				busy = true;
				annotation.overlay.style.pointerEvents = 'none';
				update();
				try {
					const blob = await annotation.renderPng(lifetime.signal);
					const fileName = `${name.slice(0, name.length - extname(name).length)}-annotated.png`;
					await target.attach(new (getWindow(anchor).File)([blob], fileName, { type: 'image/png' }), lifetime.signal);
					if (!lifetime.signal.aborted) contextViews.hide();
					target.focus();
				} finally {
					if (!lifetime.signal.aborted) {
						busy = false;
						annotation.overlay.style.pointerEvents = '';
						update();
					}
				}
			}, 'primary');
			toggle(false);
			resources.add(viewer.onDidChangeScale(update));
			resources.add(annotation.onDidChange(update));
		}
		void viewer.setSource(src, { alt: attachment.name, data: { mimeType: image.type, read } }).catch(reportError);
	}

	show(): boolean { return this.frame.show(); }
}

/** Dialog chrome is shared; each widget owns its content, pending work and visible lifetime. */
function createAttachmentPreview(
	attachment: Pick<ChatContextAttachment, 'id' | 'name'>,
	anchor: HTMLElement,
	contextViews: IContextViewService,
	resources: DisposableStore,
	options: { className: string; label: string; closeLabel: string; },
	onHide: () => void,
): { content: HTMLElement; header: HTMLElement; show(): boolean; } {
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
	const close = resources.add(new Button(header, {
		...defaultButtonStyles, label: options.closeLabel,
		icon: Lxicon.close, iconOnly: true, size: 'small', presentation: 'quiet',
	}));
	resources.add(close.onDidClick(() => contextViews.hide()));
	let visible = false;
	resources.add(toDisposable(() => { if (visible) contextViews.hide(); }));
	return {
		content, header, show: () => {
			// Alt+Enter starts at the text caret; preview dismissal returns to its native source control.
			anchor.focus({ preventScroll: true });
			visible = contextViews.show({
				anchor, content, presentation: 'dialog', focusRestore: ContextViewFocusRestore.Previous,
				onHide: () => { visible = false; onHide(); },
			});
			if (visible) close.focus();
			return visible;
		}
	};
}
