import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import './implicitContextAttachment.css';
import { h } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { isResourceDiffEditorInput } from '../../../../common/editor.js';
import { isBinaryDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { FilesAndFoldersPickerPick } from '../../../search/browser/searchChatContext.js';
import type { ChatAttachmentModel } from './chatAttachmentModel.js';

/** A suggestion reads editor state; only an explicit click creates a draft attachment. */
export class ImplicitContextAttachmentWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly button: Button;
	private readonly controller = new AbortController();
	private pending = false;

	constructor(
		container: HTMLElement,
		private readonly attachments: Pick<ChatAttachmentModel, 'attachments' | 'acquireContext' | 'onDidChange'>,
		private readonly focusInput: () => void,
		@IEditorService private readonly editors: IEditorService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-suggested-context';
		container.append(this.domNode);
		this._register(toDisposable(() => { this.controller.abort(); this.domNode.remove(); }));
		this.button = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: '',
			icon: Lxicon.addSmall,
			size: 'small',
			presentation: 'quiet',
		}));
		this._register(this.button.onDidClick(() => { void this.attach(); }));
		this._register(editors.onDidActiveEditorChange(() => this.render()));
		this._register(attachments.onDidChange(() => this.render()));
		this.render();
	}

	private get editorInput() {
		const active = this.editors.activeEditor;
		if (active && isBinaryDiffEditorInput(active)) return undefined;
		// A diff's tab URI is synthetic; its modified input owns the displayed file and version.
		const input = isResourceDiffEditorInput(active) ? active.modified : active;
		if (input?.initialBytes || input?.contentType === 'application/octet-stream') return undefined;
		const resource = input?.resource;
		// Read-only Git snapshots carry text in the input even without a filesystem provider.
		return resource && resource.scheme !== Schemas.internal && (input.initialText !== undefined || [Schemas.file, Schemas.untitled, Schemas.ashRemote, Schemas.vscodeUserData].includes(resource.scheme))
			&& !this.attachments.attachments.some(attachment => attachment.kind === 'file' && extUri.isEqual(attachment.resource, resource))
			? input : undefined;
	}

	public get accessibleContent(): string | undefined {
		const resource = this.editorInput?.resource;
		return resource ? localize('chat.context.suggestedFile', 'Suggested file context: {0}', basename(resource)) : undefined;
	}

	private render(): void {
		const resource = this.editorInput?.resource;
		const hadFocus = this.button.hasFocus();
		this.domNode.hidden = !resource;
		this.button.enabled = !this.pending;
		if (!resource) {
			if (hadFocus) this.focusInput();
			return;
		}
		const name = basename(resource);
		const label = localize('chat.context.addSuggestedFile', 'Add {0} to context', name);
		this.button.label = name;
		this.button.domNode.setAttribute('aria-label', label);
		this.button.setTitle(`${label}\n${resource.toString()}`);
	}

	private async attach(): Promise<void> {
		const input = this.editorInput;
		if (!input || this.pending) return;
		const resource = input.resource;
		this.pending = true;
		this.render();
		try {
			// Capture the clicked source, while the shared draft owner gates sending and cancels stale reads.
			const attached = await this.attachments.acquireContext(async draftSignal => {
				const signal = AbortSignal.any([this.controller.signal, draftSignal]);
				const attachment = await this.instantiation.createInstance(FilesAndFoldersPickerPick).asAttachment(resource, FileKind.File, signal, input.initialText);
				return this.attachments.attachments.some(entry => entry.kind === 'file' && extUri.isEqual(entry.resource, resource)) ? [] : [attachment];
			}, this.controller.signal);
			if (this.isDisposed) return;
			if (attached.length > 0) status(localize('chat.context.added', 'Added {0}', attached[0]!.name));
			this.focusInput();
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error)));
		} finally {
			this.pending = false;
			if (!this.isDisposed) this.render();
		}
	}
}
