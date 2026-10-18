import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { editJsonObjectProperty } from '../../../../base/common/json.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getStoredWorkspaceFolder, parseStoredWorkspaceFolders, toWorkspaceFolders } from '../../../../platform/workspaces/common/workspaces.js';
import { IFileService, FileNotFoundError } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IHostService } from '../../host/browser/host.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { IWorkspaceEditingService } from '../common/workspaceEditing.js';
import { AbstractWorkspaceEditingService } from './abstractWorkspaceEditingService.js';

/** FileService owns metadata writes; the browser host accepts the resulting workspace. */
export class BrowserWorkspaceEditingService extends AbstractWorkspaceEditingService {
	private queue: Promise<void> = Promise.resolve();
	private readonly watch = this._register(new DisposableStore());
	constructor(
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IFileDialogService dialogs: IFileDialogService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
		@IHostService hostService: IHostService,
		@IFileService private readonly files: IFileService,
		@INotificationService notifications: INotificationService,
	) {
		super(workspace, dialogs, workingCopies, hostService);
		const reload = this._register(new RunOnceScheduler(() => {
			const current = workspace.getWorkspace();
			if (!current.configuration) return;
			void this.enqueue(async () => {
				if (current !== workspace.getWorkspace()) return;
				this.ensureConfigurationSaved();
				await this.enterWorkspace(current.configuration!);
			}).catch(error => notifications.error(localize('workspace.reloadFailed', 'Could not update workspace folders. The last accepted folders were kept. {0}', String(error))));
		}, 100));
		const watchConfiguration = () => {
			this.watch.clear();
			const configuration = workspace.getWorkspace().configuration;
			if (!configuration) return;
			this.watch.add(files.watch(dirname(configuration), { recursive: false, excludes: [] }));
			this.watch.add(files.onDidChangeFiles(event => {
				if (!event.resources || event.resources.some(resource => extUriBiasedIgnorePathCase.isEqualOrParent(configuration, resource))) reload.schedule();
			}));
		};
		this._register(workspace.onDidChangeWorkspace(watchConfiguration));
		watchConfiguration();
	}

	updateFolders(index: number, deleteCount = 0, foldersToAdd: readonly { readonly uri: URI; readonly name?: string; }[] = []): Promise<void> {
		const current = this.workspace.getWorkspace();
		return this.enqueue(async () => {
			if (this.isDisposed || current !== this.workspace.getWorkspace()) throw new CancellationError();
			if (index < 0 || index > current.folders.length || deleteCount < 0 || deleteCount > current.folders.length - index) throw new RangeError(localize('workspace.invalidFolderEdit', 'Workspace folder edit is outside the current list'));
			const folders: { readonly uri: URI; readonly name?: string; }[] = current.folders.map(folder => ({ uri: folder.uri, name: folder.name }));
			folders.splice(index, deleteCount, ...foldersToAdd);
			const unique = folders.filter((folder, position) =>
				folders.findIndex(candidate => extUriBiasedIgnorePathCase.isEqual(candidate.uri, folder.uri)) === position
			);
			if (unique.length > 256) throw new RangeError(localize('workspace.folderLimit', 'Workspace supports at most 256 folders'));
			if (unique.length === current.folders.length && unique.every((folder, position) => extUriBiasedIgnorePathCase.isEqual(folder.uri, current.folders[position]!.uri) && (folder.name === undefined || folder.name === current.folders[position]!.name))) return;
			this.validateFolders(unique.map(folder => folder.uri));
			this.ensureConfigurationSaved();
			if (!current.configuration && unique.length === 1) {
				await this.hostService.openWindow([{ folderUri: unique[0]!.uri }], { forceReuseWindow: true });
				return;
			}
			const target = current.configuration ?? URI.from({ scheme: Schemas.vscodeUserData, path: `/workspaces/${crypto.randomUUID()}/workspace.ash-workspace` });
			await this.writeAndEnter(target, unique);
		});
	}

	saveAndEnterWorkspace(path: URI): Promise<void> {
		return this.enqueue(async () => {
			this.ensureConfigurationSaved();
			await this.writeAndEnter(path, this.workspace.getWorkspace().folders);
		});
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.queue.then(() => {
			if (this.isDisposed) throw new CancellationError();
			return operation();
		});
		this.queue = result.catch(() => { });
		return result;
	}

	private async writeAndEnter(target: URI, folders: readonly { readonly uri: URI; readonly name?: string; }[]): Promise<void> {
		const current = this.workspace.getWorkspace();
		const source = current.configuration ? (await this.files.readFile(current.configuration)).content : '{}\n';
		if (current.configuration) {
			const stored = toWorkspaceFolders(parseStoredWorkspaceFolders(parseJsonc(source, current.configuration.toString()), current.configuration.toString()), current.configuration);
			if (stored.length !== current.folders.length || stored.some((folder, index) => {
				const previous = current.folders[index]!;
				return !extUriBiasedIgnorePathCase.isEqual(folder.uri, previous.uri) || folder.name !== previous.name;
			})) throw new Error(localize('workspace.changedDuringEdit', 'Workspace file changed during editing'));
		}
		const output = editJsonObjectProperty(source, 'folders', folders.map(folder =>
			getStoredWorkspaceFolder(folder.uri, target.scheme === Schemas.vscodeUserData, folder.name, dirname(target))
		));
		let previous: Awaited<ReturnType<IFileService['readFile']>> | undefined;
		try { previous = await this.files.readFile(target); }
		catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
		if (this.isDisposed || current !== this.workspace.getWorkspace()) throw new CancellationError();
		if (current.configuration?.toString() === target.toString() && previous?.content !== source) throw new Error(localize('workspace.changedDuringEdit', 'Workspace file changed during editing'));
		try { await this.files.stat(dirname(target)); }
		catch (error) {
			if (!(error instanceof FileNotFoundError)) throw error;
			await this.files.createDirectory(dirname(target));
		}
		const written = await this.files.writeFile({ resource: target, content: output, expectedRevision: previous?.revision }, { create: true, overwrite: previous !== undefined });
		try {
			await this.hostService.openWindow([{ workspaceUri: target }], { forceReuseWindow: true, preserveEditors: true });
			if (this.workspace.getWorkspace().configuration?.toString() !== target.toString()) throw new CancellationError();
		} catch (error) {
			try {
				if (previous) await this.files.writeFile({ resource: target, content: previous.content, expectedRevision: written.revision }, { create: false, overwrite: true });
				else {
					if ((await this.files.readFile(target)).revision !== written.revision) throw new Error('Workspace rollback revision changed');
					await this.files.delete(target, 'ignore', 'fileOrEmptyDirectory');
				}
			} catch (rollback) { throw new AggregateError([error, rollback], 'Workspace update and metadata rollback failed'); }
			throw error;
		}
	}
}

registerSingleton(IWorkspaceEditingService, BrowserWorkspaceEditingService, InstantiationType.Delayed);
