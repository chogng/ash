import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import type { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatContextPickService, type ChatContextAttachment, type IChatContextTarget } from '../../../../services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';

interface AttachContextHost {
	readonly target: Pick<IChatContextTarget, 'addContext'>;
	readonly container: HTMLElement;
	readonly focusInput: () => void;
}

interface ContextSourceItem extends IQuickPickItem {
	readonly source: 'upload' | 'workspace' | 'editors' | 'providers';
}

interface ResourceItem extends IQuickPickItem {
	readonly resource: URI;
	readonly isDirectory: boolean;
}

/** Each picker belongs to its originating composer, even when another pane becomes active. */
export class AttachContextAction extends Disposable {
	private readonly pickers = this._register(new DisposableStore());
	private readonly uploadResources = this._register(new MutableDisposable<DisposableStore>());
	private pending = false;

	constructor(
		private readonly host: AttachContextHost,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatContextPickService private readonly contextPicks: IChatContextPickService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorGroupsService private readonly editors: IEditorGroupsService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	public async run(): Promise<void> {
		if (this.pending) { return; }
		this.pending = true;
		try {
			const openEditors = [...new Map(this.editors.groups.flatMap(group => group.inputs).map(input => [extUri.getComparisonKey(input.resource), input])).values()];
			const sources: ContextSourceItem[] = [{ label: localize('chat.attach.files', 'Attach files'), source: 'upload' }];
			if (this.workspace.getWorkspace().folders.length) {
				sources.push({ label: localize('chat.context.workspace', 'Workspace files'), source: 'workspace' });
			}
			if (openEditors.length) {
				sources.push({ label: localize('chat.context.editors', 'Open editors'), source: 'editors' });
			}
			if ((await Promise.all(this.contextPicks.items.map(picker => picker.isEnabled()))).some(Boolean)) {
				sources.push({ label: localize('chat.context.providers', 'Other context sources'), source: 'providers' });
			}
			if (this.isDisposed) { return; }
			const source = await this.pick(sources, localize('chat.context.add', 'Add context'));
			if (!source || this.isDisposed) { return; }
			if (source.source === 'upload') { this.showFilePicker(); return; }
			let attachment: ChatContextAttachment | undefined;
			if (source.source === 'providers') {
				const controller = new AbortController();
				const cancellation = this.pickers.add(toDisposable(() => controller.abort()));
				try { attachment = await this.contextPicks.pickContext(this.quickInput, controller.signal); }
				finally { cancellation.dispose(); }
			} else {
				let resource: URI | undefined;
				if (source.source === 'workspace') {
					resource = await this.pickWorkspaceFile();
				} else {
					const items = openEditors.map(editor => ({ label: basename(editor.resource), description: editor.resource.path, resource: editor.resource, isDirectory: false }));
					resource = (await this.pick(items, localize('chat.context.editors', 'Open editors')))?.resource;
				}
				if (!resource || this.isDisposed) { return; }
				const name = basename(resource);
				// Capture a snapshot now: draft persistence and Turn submission must use the same content.
				const copy = this.workingCopies.get(resource).find(candidate => candidate.backupKind === 'text');
				const content = copy ? copy.backup() : (await this.files.readFile(resource)).content;
				if (content.includes('\0') || !content.trim()) {
					throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', name));
				}
				attachment = { id: `file:${extUri.getComparisonKey(resource)}`, kind: 'file', name, resolve: async () => ({ name, content }) };
			}
			if (attachment && !this.isDisposed) {
				this.host.target.addContext(attachment);
				status(localize('chat.context.added', 'Added {0}', attachment.name));
			}
		} catch (error) {
			if (!this.isDisposed) { this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error))); }
		} finally {
			this.pending = false;
			this.pickers.clear();
			if (!this.isDisposed) { this.host.focusInput(); }
		}
	}

	private showFilePicker(): void {
		const input = h(this.host.container.ownerDocument, 'input');
		input.type = 'file';
		input.multiple = true;
		input.hidden = true;
		input.setAttribute('aria-label', localize('chat.attach.files', 'Attach files'));
		this.host.container.append(input);
		const resources = new DisposableStore();
		this.uploadResources.value = resources;
		resources.add(toDisposable(() => input.remove()));
		resources.add(addDisposableListener(input, 'cancel', () => { this.uploadResources.clear(); this.host.focusInput(); }));
		resources.add(addDisposableListener(input, 'change', () => {
			const files = [...(input.files ?? [])];
			this.uploadResources.clear();
			void this.attachFiles(files);
		}));
		input.click();
	}

	private async attachFiles(files: readonly File[]): Promise<void> {
		try {
			const attachments = await Promise.all(files.map(async file => {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (!bytes.length) { throw new Error(localize('chat.attach.empty', '{0} is empty', file.name)); }
				const image = /^image\/(png|jpeg|gif|webp)$/u.test(file.type);
				let content: string;
				if (image) {
					let binary = '';
					for (let offset = 0; offset < bytes.length; offset += 8192) {
						binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
					}
					content = `data:${file.type};base64,${btoa(binary)}`;
				} else {
					try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
					catch { throw new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name)); }
					if (content.includes('\0') || !content.trim()) {
						throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', file.name));
					}
				}
				return { id: createUuid(), name: file.name, kind: image ? 'image' : 'file', resolve: async () => image ? { name: file.name, content, kind: 'image' as const } : { name: file.name, content } };
			}));
			if (!this.isDisposed) {
				for (const attachment of attachments) { this.host.target.addContext(attachment); }
				status(localize('chat.context.filesAdded', 'Added {0} attachments', attachments.length));
			}
		} catch (error) {
			if (!this.isDisposed) { this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error))); }
		} finally {
			if (!this.isDisposed) { this.host.focusInput(); }
		}
	}

	private async pickWorkspaceFile(): Promise<URI | undefined> {
		const folders = this.workspace.getWorkspace().folders;
		let directory = folders.length === 1 ? folders[0].uri : (await this.pick(folders.map(folder => ({ label: folder.name, resource: folder.uri, isDirectory: true })), localize('chat.context.workspace', 'Workspace files')))?.resource;
		const trail: URI[] = [];
		while (directory && !this.isDisposed) {
			const entries = await this.files.readDirectory(directory);
			if (this.isDisposed) { return undefined; }
			const items = entries.filter(entry => entry.kind === FileKind.Directory || entry.kind === FileKind.File).map(entry => ({ label: entry.kind === FileKind.Directory ? `${entry.name}/` : entry.name, resource: entry.resource, isDirectory: entry.kind === FileKind.Directory }));
			items.sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.label.localeCompare(right.label));
			if (trail.length) { items.unshift({ label: localize('chat.context.parent', 'Parent folder'), resource: trail[trail.length - 1], isDirectory: true }); }
			const selected = await this.pick<ResourceItem>(items, localize('chat.context.chooseFile', 'Choose a file in {0}', directory.path));
			if (!selected) { return undefined; }
			if (!selected.isDirectory) { return selected.resource; }
			if (trail.length && extUri.isEqual(selected.resource, trail[trail.length - 1])) { trail.pop(); }
			else { trail.push(directory); }
			directory = selected.resource;
		}
		return undefined;
	}

	private pick<T extends IQuickPickItem>(items: readonly T[], label: string): Promise<T | undefined> {
		const picker = this.quickInput.createQuickPick<T>();
		const resources = this.pickers.add(new DisposableStore());
		resources.add(picker);
		picker.items = items;
		picker.ariaLabel = label;
		picker.placeholder = label;
		return new Promise(resolve => {
			let finished = false;
			const finish = (item?: T): void => {
				if (finished) { return; }
				finished = true;
				resolve(item);
				resources.dispose();
			};
			resources.add(toDisposable(() => finish()));
			resources.add(picker.onDidAccept(item => finish(item)));
			resources.add(picker.onDidHide(() => finish()));
			picker.show();
		});
	}
}
