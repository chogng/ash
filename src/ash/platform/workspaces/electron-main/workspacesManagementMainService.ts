import { basename as resourceBasename } from '../../../base/common/resources.js';
import { getRemoteAuthority } from '../../remote/common/remoteHosts.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../remote/common/remote.js';
import { parseWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { localize } from '../../../nls.js';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { editJsonObjectProperty } from '../../../base/common/json.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { DiskFileSystemProvider } from '../../files/node/diskFileSystemProvider.js';
import { FileNotFoundError, FileRevisionConflictError } from '../../files/common/files.js';
import type { WorkspaceContextMainService } from '../../window/electron-main/window.js';
import type { WorkspaceEditRequest, WorkspaceConfigurationRequest } from '../../workspace/common/workspaceIpc.js';
import { hasWorkspaceFileExtension, isWorkspaceIdentifier, serializeWorkspace, getWorkspaceRemoteAuthority } from '../../workspace/common/workspace.js';
import { getWorkspaceIdentifier } from '../node/workspaces.js';
import type { WorkspaceTrustGrant } from '../../workspace/common/workspaceTrust.js';
import { parseJsonc } from '../../../base/common/jsonc.js';
import { URI } from '../../../base/common/uri.js';
import { type IAnyWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier, type IWorkspace, type IWorkspaceFolder, workspaceFromIdentifier } from '../../workspace/common/workspace.js';
import { parseStoredWorkspaceFolders } from '../common/workspaces.js';
import { getSingleFolderWorkspaceIdentifier, nodeWorkspacePathService, stableWorkspaceId, type IWorkspacePathService, WorkspacePathKind } from '../node/workspaces.js';

/** Resolves workspace files and canonical folder identities for desktop windows. */
export class WorkspacesManagementMainService {
	constructor(private readonly pathService: IWorkspacePathService = nodeWorkspacePathService) { }

	public async resolveFolder(path: string): Promise<ISingleFolderWorkspaceIdentifier> {
		const folder = await this.pathService.resolvePath(resolve(path));
		if (folder.kind !== WorkspacePathKind.Directory) {
			throw new Error(`Workspace folder is not a directory: ${path}`);
		}
		return getSingleFolderWorkspaceIdentifier(URI.file(folder.path));
	}

	public async resolveWorkspace(identifier: IAnyWorkspaceIdentifier): Promise<IWorkspace> {
		if (!('configPath' in identifier)) {
			return workspaceFromIdentifier(identifier);
		}
		if (!this.pathService.readFile) {
			throw new Error('Workspace configuration reading is unavailable');
		}
		if (identifier.configPath.scheme !== 'file') throw new TypeError(localize('workspace.localConfigurationOnly', 'Desktop workspace configuration must be a local file.'));
		const configPath = identifier.configPath.fsPath;
		const source = await this.pathService.readFile(configPath);
		const document = parseJsonc(source, configPath) as { remoteAuthority?: unknown; };
		const configuredFolders = parseStoredWorkspaceFolders(document, configPath);
		const storedAuthority = document.remoteAuthority === undefined ? undefined : getWorkspaceRemoteAuthority(parseWorkspaceIdentifier({ id: identifier.id, remoteAuthority: document.remoteAuthority }));
		let remoteAuthority = identifier.remoteAuthority ?? storedAuthority;
		if (identifier.remoteAuthority && storedAuthority && identifier.remoteAuthority !== storedAuthority) throw new Error(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
		const folders: IWorkspaceFolder[] = [];
		const identities = new Set<string>();
		for (const configured of configuredFolders) {
			const remote = configured.uri ? URI.parse(configured.uri) : undefined;
			if (remote && isRemoteResource(remote)) {
				getRemoteWorkspacePath(remote);
				const authority = getRemoteAuthority(remote)!;
				if (remoteAuthority && remoteAuthority !== authority || folders.some(folder => !isRemoteResource(folder.uri))) throw new Error(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
				remoteAuthority = authority;
				const id = stableWorkspaceId(remote);
				if (identities.has(id)) continue;
				identities.add(id);
				folders.push(Object.freeze({ id, uri: remote, name: configured.name ?? resourceBasename(remote), index: folders.length }));
				continue;
			}
			if (remoteAuthority) throw new Error(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
			const requestedPath = configured.path ?? URI.parse(configured.uri!).fsPath;
			const absolutePath = isAbsolute(requestedPath) ? requestedPath : resolve(dirname(configPath), requestedPath);
			const resolved = await this.pathService.resolvePath(absolutePath);
			if (resolved.kind !== WorkspacePathKind.Directory) {
				throw new Error(`Workspace folder is not a directory: ${requestedPath}`);
			}
			const uri = URI.file(resolved.path);
			const identity = process.platform === 'linux' ? uri.toString() : uri.toString().toLowerCase();
			if (identities.has(identity)) {
				continue;
			}
			identities.add(identity);
			folders.push(Object.freeze({
				id: stableWorkspaceId(uri),
				uri,
				name: configured.name ?? (basename(resolved.path) || resolved.path),
				index: folders.length,
			}));
		}
		return Object.freeze({
			id: identifier.id,
			folders: Object.freeze(folders),
			configuration: identifier.configPath,
			name: workspaceFromIdentifier(identifier).name,
			...(remoteAuthority ? { remoteAuthority } : {}),
		});
	}
}

/** Serializes metadata edits and external folder changes for one window.
 * The window context remains authoritative and is published only after metadata
 * persistence and backend directory acceptance. Invalid external edits retain
 * the last accepted workspace and are retried on the next filesystem change.
 */
export class WorkspaceEditingMainService extends Disposable {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly watcher = this._register(new MutableDisposable());
	private readonly reload = this._register(new RunOnceScheduler(() => {
		void this.enqueue(() => this.reloadWorkspace()).catch(this.reportError);
	}, 100));

	constructor(
		private readonly context: WorkspaceContextMainService,
		private readonly workspaces: WorkspacesManagementMainService,
		private readonly untitledHome: string,
		private readonly host: {
			resolveGrant(path: string): Promise<WorkspaceTrustGrant | undefined>;
			persistDirectoryGrant(path: string, grant: WorkspaceTrustGrant): Promise<void>;
			setFolders(folders: readonly { id: string; path: string; grant: WorkspaceTrustGrant; }[]): Promise<void>;
			validateFolders(folders: readonly { id: string; path: string; grant: WorkspaceTrustGrant; }[]): Promise<void>;
		},
		private readonly reportError: (error: unknown) => void,
		private readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>,
		private readonly configurationChanged: () => void = () => { },
	) {
		super();
		this._register(context.onDidChangeWorkspace(() => this.watchConfiguration()));
		this.watchConfiguration();
	}

	configuration(request: WorkspaceConfigurationRequest): Promise<unknown> {
		const access = async (): Promise<unknown> => {
			this.assertNotDisposed();
			const resource = this.context.getResolvedWorkspace().configuration;
			if (!resource || resource.toString() !== request.uri) {
				// Main can commit a replacement before Renderer receives its context
				// event. Cancel that obsolete read without granting any file access.
				if (request.operation === 'read') return { error: 'notCurrent' };
				throw new Error('Only the current workspace configuration file is accessible');
			}
			using disk = new DiskFileSystemProvider([URI.file(dirname(resource.fsPath))]);
			try {
				const result = request.operation === 'read' ? await disk.readFile(resource)
					: await disk.writeFile(resource, new TextEncoder().encode(request.content), request.options);
				const stat = await disk.stat(resource);
				return {
					revision: result.revision, sizeBytes: stat.sizeBytes, readonly: stat.readonly, modifiedAtMillis: stat.modifiedAtMillis,
					...(request.operation === 'read' && 'bytes' in result ? { content: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes) } : {})
				};
			} catch (error) {
				if (error instanceof FileRevisionConflictError) return { error: 'revisionConflict' };
				if (error instanceof FileNotFoundError) return { error: 'notFound' };
				throw error;
			}
		};
		// A replacement window waits for renderer readiness, which itself needs to
		// read this file. Reads must bypass both editing queues; writes still join
		// the window transaction and keep their revision checks.
		return request.operation === 'read' ? access() : this.enqueue(access);
	}

	edit(request: WorkspaceEditRequest): Promise<unknown> {
		return this.enqueue(async () => {
			this.assertNotDisposed();
			const remoteAuthority = getWorkspaceRemoteAuthority(this.context.getResolvedWorkspace());
			const current = this.context.getResolvedWorkspace();
			const identifier = this.context.getWorkspace();
			const source = isWorkspaceIdentifier(identifier) ? await readFile(identifier.configPath.fsPath, 'utf8') : '{}\n';
			const latest = isWorkspaceIdentifier(identifier) ? await this.workspaces.resolveWorkspace(identifier) : current;
			if (request.operation === 'folders' && JSON.stringify(latest.folders) !== JSON.stringify(current.folders)) {
				// Index-based edits refer to the list the renderer actually displayed.
				// Let the external edit settle before retrying, rather than deleting or
				// inserting against a different on-disk ordering.
				this.reload.schedule();
				throw new Error(localize('workspace.changedDuringEdit', 'Workspace file changed during editing'));
			}
			let folders = [...latest.folders];
			if (request.operation === 'folders') {
				if (request.index > folders.length || request.deleteCount > folders.length - request.index) throw new RangeError(localize('workspace.invalidFolderEdit', 'Workspace folder edit is outside the current list'));
				const added = await Promise.all(request.folders.map(async entry => {
					const uri = URI.parse(entry.uri);
					if (remoteAuthority) {
						if (!isRemoteResource(uri) || getRemoteAuthority(uri) !== remoteAuthority) throw new TypeError(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
						getRemoteWorkspacePath(uri);
						return { id: stableWorkspaceId(uri), uri, name: entry.name ?? resourceBasename(uri), index: 0 };
					}
					if (uri.scheme !== 'file' || uri.query || uri.fragment || !isAbsolute(uri.fsPath)) throw new TypeError(localize('workspace.localFoldersOnly', 'Workspace folders must be absolute local directories'));
					const resolved = await this.workspaces.resolveFolder(uri.fsPath);
					return { id: resolved.id, uri: resolved.uri, name: entry.name ?? (basename(resolved.uri.fsPath) || resolved.uri.fsPath), index: 0 };
				}));
				folders.splice(request.index, request.deleteCount, ...added);
			}
			const identities = new Set<string>();
			folders = folders.filter(folder => {
				if (identities.has(folder.id)) return false;
				identities.add(folder.id);
				return true;
			}).map((folder, index) => ({ ...folder, index }));
			if (folders.length > 256) throw new RangeError(localize('workspace.folderLimit', 'Workspace supports at most 256 folders'));
			// A duplicate or empty edit must not create a workspace identity or rewrite
			// the user's JSONC when the accepted folder list did not change.
			if (request.operation === 'folders' && folders.length === current.folders.length && folders.every((folder, index) => {
				const previous = current.folders[index]!;
				return folder.id === previous.id && folder.uri.toString() === previous.uri.toString() && folder.name === previous.name;
			})) {
				return serializeWorkspace(current);
			}
			const path = request.operation === 'save' ? resolve(request.path)
				: current.configuration?.fsPath ?? resolve(this.untitledHome, randomUUID(), 'workspace.ash-workspace');
			if (!hasWorkspaceFileExtension(path)) throw new TypeError(localize('workspace.invalidExtension', 'Expected an .ash-workspace or .code-workspace file'));
			const configPath = URI.file(path);
			const nextIdentifier = getWorkspaceIdentifier(configPath, remoteAuthority);
			const next: IWorkspace = { id: nextIdentifier.id, configuration: configPath, name: basename(path).replace(/\.(ash|code)-workspace$/i, ''), folders, ...(remoteAuthority ? { remoteAuthority } : {}) };
			// Rebase relative paths when saving elsewhere. Preserve settings, tasks,
			// launch, extensions, unknown properties and comments outside folders.
			let output = editJsonObjectProperty(source, 'folders', folders.map(folder => remoteAuthority ? { uri: folder.uri.toString(), name: folder.name } : {
				path: sep === '\\' ? (relative(dirname(path), folder.uri.fsPath) || '.').replaceAll('\\', '/') : relative(dirname(path), folder.uri.fsPath) || '.', name: folder.name,
			}));
			if (remoteAuthority) output = editJsonObjectProperty(output, 'remoteAuthority', remoteAuthority);
			await mkdir(dirname(path), { recursive: true });
			using disk = new DiskFileSystemProvider([URI.file(dirname(path))]);
			let revision: string | undefined;
			let previousContent: Uint8Array | undefined;
			try {
				const previous = await disk.readFile(configPath);
				revision = previous.revision;
				previousContent = previous.bytes;
				if (current.configuration?.toString() === configPath.toString() && new TextDecoder().decode(previous.bytes) !== source) throw new Error(localize('workspace.changedDuringEdit', 'Workspace file changed during editing'));
			} catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
			await this.apply(next, async () => {
				const written = await disk.writeFile(configPath, new TextEncoder().encode(output), { create: true, overwrite: revision !== undefined, expectedRevision: revision });
				return async () => {
					if (previousContent) await disk.writeFile(configPath, previousContent, { create: false, overwrite: true, expectedRevision: written.revision });
					else {
						if ((await disk.readFile(configPath)).revision !== written.revision) throw new FileRevisionConflictError(configPath);
						await disk.delete(configPath, 'ignore', 'fileOrEmptyDirectory');
					}
				};
			});
			return serializeWorkspace(this.context.getResolvedWorkspace());
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(() => this.runExclusive ? this.runExclusive(operation) : operation());
		this.queue = result.catch(() => undefined);
		return result;
	}

	private watchConfiguration(): void {
		this.watcher.clear();
		const config = this.context.getResolvedWorkspace().configuration;
		if (!config) return;
		try {
			// Watch the parent so atomic replacement by another editor remains visible.
			const watcher = watch(dirname(config.fsPath), { persistent: false }, (_event, filename) => {
				if (!filename || filename.toString() === basename(config.fsPath)) {
					this.configurationChanged();
					this.reload.schedule();
				}
			});
			watcher.on('error', this.reportError);
			this.watcher.value = toDisposable(() => watcher.close());
		} catch (error) { this.reportError(error); }
	}

	private async reloadWorkspace(): Promise<void> {
		if (this.isDisposed) return;
		const identifier = this.context.getWorkspace();
		if (!isWorkspaceIdentifier(identifier)) return;
		const next = await this.workspaces.resolveWorkspace(identifier);
		if (JSON.stringify(next.folders) !== JSON.stringify(this.context.getResolvedWorkspace().folders)) await this.apply(next);
	}

	private async apply(next: IWorkspace, persist?: () => Promise<() => Promise<void>>): Promise<void> {
		const previous = this.context.getResolvedWorkspace();
		const changed = previous.folders.length !== next.folders.length || previous.folders.some((folder, index) => folder.id !== next.folders[index]?.id);
		const dirs = next.folders.map(folder => ({ id: folder.id, path: isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath, grant: { type: 'config' as const } }));
		if (changed) {
			await this.host.validateFolders(dirs);
			for (const folder of next.folders) {
				const grant = await this.host.resolveGrant(isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath);
				if (!grant) throw new Error(localize('workspace.permissionsCancelled', 'Directory permissions were not selected'));
				await this.host.persistDirectoryGrant(isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath, grant);
			}
		}
		// Disk conflicts must be detected before retiring any backend resources.
		// A rejected backend update restores only our metadata revision; an external
		// writer's newer content is never overwritten by rollback.
		const rollback = await persist?.();
		try {
			if (changed) {
				await this.host.validateFolders(dirs);
				await this.host.setFolders(dirs);
			}
		} catch (error) {
			try { await rollback?.(); }
			catch (failure) { throw new AggregateError([error, failure], 'Workspace update and metadata rollback failed'); }
			throw error;
		}
		this.assertNotDisposed();
		this.context.updateWorkspace(getWorkspaceIdentifier(next.configuration!, getWorkspaceRemoteAuthority(next)), next);
	}
}
