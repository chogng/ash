import { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { pickFiles } from '../../../../../base/browser/fileAccess.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import type { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
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
}

/** Each picker belongs to its originating composer, even when another pane becomes active. */
export class AttachContextAction extends Disposable {
	private readonly pickers = this._register(new DisposableStore());
	private pending = false;

	constructor(
		private readonly host: AttachContextHost,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatContextPickService private readonly contextPicks: IChatContextPickService,
		@IFileService private readonly files: IFileService,
		@IFileSearchService private readonly fileSearch: IFileSearchService,
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
			if (source.source === 'upload') { await this.showFilePicker(); return; }
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
					const items = openEditors.map(editor => ({ label: basename(editor.resource), description: editor.resource.path, resource: editor.resource }));
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

	private async showFilePicker(): Promise<void> {
		const controller = new AbortController();
		this.pickers.add(toDisposable(() => controller.abort()));
		const files = await pickFiles({
			ownerDocument: this.host.container.ownerDocument,
			selection: 'multiple',
			ariaLabel: localize('chat.attach.files', 'Attach files'),
			signal: controller.signal,
		});
		if (files && !this.isDisposed) { await this.attachFiles(files); }
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
		}
	}

	private async pickWorkspaceFile(): Promise<URI | undefined> {
		const folders = this.workspace.getWorkspace().folders;
		const folder = folders.length === 1 ? folders[0] : (await this.pick(folders.map(folder => ({ label: folder.name, folder })), localize('chat.context.workspace', 'Workspace files')))?.folder;
		if (!folder || this.isDisposed) { return undefined; }
		const resources = this.pickers.add(new DisposableStore());
		const picker = resources.add(this.quickInput.createQuickPick<ResourceItem>());
		const cancellation = resources.add(new MutableDisposable());
		picker.ariaLabel = localize('chat.context.chooseFile', 'Choose a file in {0}', folder.uri.path);
		picker.placeholder = localize('chat.context.filePattern', 'Search file paths (for example, src/*.ts)');
		// Results are filtered by the search owner, including paths beyond the initial result limit.
		picker.filterValue = () => '';
		return new Promise((resolve, reject) => {
			let finished = false;
			const finish = (resource?: URI, error?: unknown): void => {
				if (finished) { return; }
				finished = true;
				if (error) { reject(error); } else { resolve(resource); }
				resources.dispose();
			};
			resources.add(toDisposable(() => finish()));
			resources.add(picker.onDidAccept(item => finish(item.resource)));
			resources.add(picker.onDidHide(() => finish()));
			const search = async (value: string): Promise<void> => {
				const controller = new AbortController();
				cancellation.value = toDisposable(() => controller.abort());
				picker.items = [];
				// Plain text is a literal path fragment; explicit wildcards use the backend glob grammar.
				const pattern = /[*?{[]/.test(value) ? value : `**/*${value.replace(/[\\*?{}[\]]/g, '\\$&')}*`;
				try {
					const found = await this.fileSearch.glob({ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } }, { includePatterns: value ? [pattern] : [], excludePatterns: [], maxResults: 100 }, controller.signal);
					if (!finished && !controller.signal.aborted) { picker.items = found.matches.map(item => ({ label: item.path, resource: item.resource })); }
				} catch (error) {
					if (!controller.signal.aborted) { finish(undefined, error); }
				}
			};
			resources.add(picker.onDidChangeValue(value => { void search(value); }));
			picker.show();
			void search('');
		});
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
