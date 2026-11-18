import { basename as resourceBasename } from '../../../base/common/resources.js';
import { getRemoteAuthority } from '../../remote/common/remoteHosts.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../remote/common/remote.js';
import { parseWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { localize } from '../../../nls.js';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { editJsonObjectProperty } from '../../../base/common/json.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { DiskFileSystemProvider } from '../../files/node/diskFileSystemProvider.js';
import { FileNotFoundError, FileRevisionConflictError } from '../../files/common/files.js';
import type { WorkspaceContextMainService } from '../../window/electron-main/window.js';
import type { WorkspaceEditRequest, WorkspaceConfigurationRequest } from '../../workspace/common/workspaceIpc.js';
import { hasWorkspaceFileExtension, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, serializeWorkspace, getWorkspaceRemoteAuthority } from '../../workspace/common/workspace.js';
import { getWorkspaceIdentifier } from '../node/workspaces.js';
import type { WorkspaceTrustGrant } from '../../workspace/common/workspaceTrust.js';
import { parseJsonc } from '../../../base/common/jsonc.js';
import { URI } from '../../../base/common/uri.js';
import { type IAnyWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier, type IWorkspace, type IWorkspaceFolder, workspaceFromIdentifier } from '../../workspace/common/workspace.js';
import { parseStoredWorkspaceFolders } from '../common/workspaces.js';
import { getSingleFolderWorkspaceIdentifier, nodeWorkspacePathService, stableWorkspaceId, type IResolvedWorkspacePath, type IWorkspacePathService, WorkspacePathKind } from '../node/workspaces.js';

// Keep filesystem work bounded when opening a large multi-root workspace.
const concurrentWorkspacePathResolutions = 4;

/** Resolves workspace files and canonical folder identities for desktop windows. */
export class WorkspacesManagementMainService {
	constructor(private readonly pathService: IWorkspacePathService = nodeWorkspacePathService) { }

	public async resolveFolder(path: string): Promise<ISingleFolderWorkspaceIdentifier> {
		const folder = await this.pathService.resolvePath(resolve(path));
		return getSingleFolderWorkspaceIdentifier(URI.file(requireFolderPath(folder, path)));
	}

	public async resolveWorkspace(identifier: IAnyWorkspaceIdentifier, options?: { readonly restoring?: boolean; readonly source?: string; }): Promise<IWorkspace> {
		if (!('configPath' in identifier)) {
			// Restoring a saved folder bypasses the normal launch-target validation.
			if (options?.restoring && isSingleFolderWorkspaceIdentifier(identifier) && identifier.uri.scheme === 'file') {
				await this.resolveFolder(identifier.uri.fsPath);
			}
			return workspaceFromIdentifier(identifier);
		}
		if (identifier.configPath.scheme !== 'file') throw new TypeError(localize('workspace.localConfigurationOnly', 'Desktop workspace configuration must be a local file.'));
		const configPath = identifier.configPath.fsPath;
		const source = options?.source ?? await this.readWorkspaceFile(identifier.configPath);
		const document = parseJsonc(source, configPath) as { remoteAuthority?: unknown; transient?: unknown; } | null;
		const configuredFolders = parseStoredWorkspaceFolders(document, configPath);
		if (options?.restoring && document?.transient === true) throw new Error(`Cannot restore transient workspace: ${configPath}`);
		const storedAuthority = document?.remoteAuthority === undefined ? undefined : getWorkspaceRemoteAuthority(parseWorkspaceIdentifier({ id: identifier.id, remoteAuthority: document.remoteAuthority }));
		let remoteAuthority = identifier.remoteAuthority ?? storedAuthority;
		if (identifier.remoteAuthority && storedAuthority && identifier.remoteAuthority !== storedAuthority) throw new Error(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
		const folders: IWorkspaceFolder[] = [];
		const identities = configuredFolders.length > 1 ? new Set<string>() : undefined;
		const localFolders: { readonly path: string; readonly name?: string; }[] | undefined = identities ? [] : undefined;
		for (const configured of configuredFolders) {
			const resource = configured.uri ? URI.parse(configured.uri) : undefined;
			if (resource && isRemoteResource(resource)) {
				getRemoteWorkspacePath(resource);
				const authority = getRemoteAuthority(resource)!;
				if (remoteAuthority && remoteAuthority !== authority || localFolders?.length) throw new Error(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
				remoteAuthority = authority;
				const id = stableWorkspaceId(resource);
				if (identities?.has(id)) continue;
				identities?.add(id);
				folders.push(Object.freeze({ id, uri: resource, name: configured.name ?? resourceBasename(resource), index: folders.length }));
				continue;
			}
			if (remoteAuthority) throw new Error(localize('workspace.remoteAuthorityMismatch', 'Workspace folders must belong to one remote host.'));
			const path = configured.path ?? resource!.fsPath;
			if (!localFolders) {
				const result = await this.pathService.resolvePath(isAbsolute(path) ? path : resolve(dirname(configPath), path));
				folders.push(toLocalWorkspaceFolder(requireFolderPath(result, path), configured.name, 0));
			} else {
				localFolders.push({ path, name: configured.name });
			}
		}
		if (localFolders?.length) await this.resolveLocalFolders(dirname(configPath), localFolders, folders);
		return Object.freeze({
			id: identifier.id,
			folders: Object.freeze(folders),
			configuration: identifier.configPath,
			name: workspaceFromIdentifier(identifier).name,
			...(remoteAuthority ? { remoteAuthority } : {}),
		});
	}

	public readWorkspaceFile(config: URI): Promise<string> {
		if (config.scheme !== 'file') throw new TypeError(localize('workspace.localConfigurationOnly', 'Desktop workspace configuration must be a local file.'));
		if (!this.pathService.readFile) throw new Error('Workspace configuration reading is unavailable');
		return this.pathService.readFile(config.fsPath);
	}

	private async resolveLocalFolders(
		directory: string,
		configured: readonly { readonly path: string; readonly name?: string; }[],
		folders: IWorkspaceFolder[],
	): Promise<void> {
		const paths = new Map<string, Promise<IResolvedWorkspacePath>>();
		const resolved: string[] = new Array(configured.length);
		let next = 0;
		let failed = false;
		const resolvePaths = async () => {
			try {
				// A slow root holds only its own slot. Start no further reads after rejection.
				while (!failed && next < configured.length) {
					const index = next++;
					const folder = configured[index]!;
					const path = isAbsolute(folder.path) ? folder.path : resolve(directory, folder.path);
					let pending = paths.get(path);
					if (!pending) {
						pending = this.pathService.resolvePath(path);
						paths.set(path, pending);
					}
					resolved[index] = requireFolderPath(await pending, folder.path);
				}
			} catch (error) {
				failed = true;
				throw error;
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrentWorkspacePathResolutions, configured.length) }, resolvePaths));
		// Apply names and deduplicate canonical paths in the order stored in the file.
		const identities = new Set<string>();
		for (const [index, path] of resolved.entries()) {
			const folder = toLocalWorkspaceFolder(path, configured[index]!.name, folders.length);
			if (identities.has(folder.id)) continue;
			identities.add(folder.id);
			folders.push(folder);
		}
	}
}

function requireFolderPath(resolved: IResolvedWorkspacePath, requested: string): string {
	if (resolved.kind !== WorkspacePathKind.Directory) throw new Error(`Workspace folder is not a directory: ${requested}`);
	return resolved.path;
}

function toLocalWorkspaceFolder(path: string, name: string | undefined, index: number): IWorkspaceFolder {
	const uri = URI.file(path);
	return Object.freeze({ id: stableWorkspaceId(uri), uri, name: name ?? (basename(path) || path), index });
}

function sameWorkspaceFolders(left: readonly IWorkspaceFolder[], right: readonly IWorkspaceFolder[]): boolean {
	return left.length === right.length && left.every((folder, index) => {
		const other = right[index]!;
		return folder.id === other.id && folder.name === other.name && folder.index === other.index && folder.uri.toString() === other.uri.toString();
	});
}

function matchesConfigurationUri(resource: URI, requested: string): boolean {
	const current = resource.toString();
	if (current === requested) return true;
	// Chromium and Node can serialize the same Windows drive with different case.
	// Leave the rest of the path exact, including case-sensitive directories.
	const drive = /^file:\/\/\/[a-zA-Z]:\//u;
	return process.platform === 'win32' && current.replace(drive, value => value.toLowerCase()) === requested.replace(drive, value => value.toLowerCase());
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
			if (!resource || !matchesConfigurationUri(resource, request.uri)) {
				// Main can commit a replacement before Renderer receives its context
				// event. Cancel that obsolete read without granting any file access.
				if (request.operation === 'read') return { error: 'notCurrent' };
				throw new Error('Only the current workspace configuration file is accessible');
			}
			using disk = new DiskFileSystemProvider([URI.file(dirname(resource.fsPath))]);
			try {
				const result = request.operation === 'read' ? await disk.readFile(resource)
					: await disk.writeFile(resource, new TextEncoder().encode(request.content), request.options);
				const stat = 'stat' in result ? result.stat : await disk.stat(resource);
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

	edit(request: Exclude<WorkspaceEditRequest, { operation: 'folderLocation'; }>): Promise<unknown> {
		return this.enqueue(async () => {
			this.assertNotDisposed();
			const current = this.context.getResolvedWorkspace();
			const remoteAuthority = getWorkspaceRemoteAuthority(current);
			const identifier = this.context.getWorkspace();
			// Index checks and the edit must use the same contents. The conditional write
			// still detects an external change after this read.
			const source = isWorkspaceIdentifier(identifier) ? await this.workspaces.readWorkspaceFile(identifier.configPath) : '{}\n';
			const latest = isWorkspaceIdentifier(identifier) ? await this.workspaces.resolveWorkspace(identifier, { source }) : current;
			if (request.operation === 'folders' && !sameWorkspaceFolders(latest.folders, current.folders)) {
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
			if (request.operation === 'folders' && sameWorkspaceFolders(folders, current.folders)) {
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
			using disk = new DiskFileSystemProvider([URI.file(dirname(path))]);
			let revision: string | undefined;
			let previousContent: Uint8Array | undefined;
			try {
				const previous = await disk.readFile(configPath);
				revision = previous.revision;
				previousContent = previous.bytes;
				if (current.configuration && matchesConfigurationUri(current.configuration, configPath.toString()) && new TextDecoder().decode(previous.bytes) !== source) throw new Error(localize('workspace.changedDuringEdit', 'Workspace file changed during editing'));
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
		if (!sameWorkspaceFolders(next.folders, this.context.getResolvedWorkspace().folders)) await this.apply(next);
	}

	private async apply(next: IWorkspace, persist?: () => Promise<() => Promise<void>>): Promise<void> {
		const previous = this.context.getResolvedWorkspace();
		const changed = previous.folders.length !== next.folders.length || previous.folders.some((folder, index) => folder.id !== next.folders[index]?.id);
		const dirs = changed ? next.folders.map(folder => ({
			id: folder.id,
			path: isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath,
			grant: { type: 'config' as const },
		})) : undefined;
		if (dirs) {
			await this.host.validateFolders(dirs);
			for (const { path } of dirs) {
				const grant = await this.host.resolveGrant(path);
				if (!grant) throw new Error(localize('workspace.permissionsCancelled', 'Directory permissions were not selected'));
				await this.host.persistDirectoryGrant(path, grant);
			}
		}
		// Disk conflicts must be detected before retiring any backend resources.
		// A rejected backend update restores only our metadata revision; an external
		// writer's newer content is never overwritten by rollback.
		const rollback = await persist?.();
		try {
			if (dirs) {
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
