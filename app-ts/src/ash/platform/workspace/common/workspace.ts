import { URI } from "../../../base/common/uri.js";
import type { Event } from "../../../base/common/event.js";
import { isNonEmptyString } from "../../../base/common/types.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";
import { getRemoteWorkspacePath, isRemoteResource } from "../../remote/common/remote.js";

/** Describes whether a workbench contains no project, one folder, or a workspace. */
export const enum WorkbenchState {
	EMPTY = 1,
	FOLDER,
	WORKSPACE,
}

/** Stable string projection used when exposing a Workbench state outside the workspace model. */
export type WorkbenchStateValue = 'empty' | 'folder' | 'workspace';

export function workbenchStateToString(state: WorkbenchState): WorkbenchStateValue {
	switch (state) {
		case WorkbenchState.EMPTY:
			return 'empty';
		case WorkbenchState.FOLDER:
			return 'folder';
		case WorkbenchState.WORKSPACE:
			return 'workspace';
	}
}

/** Identity shared by empty, single-folder, and multi-root workspaces. */
export interface IBaseWorkspaceIdentifier {
	readonly id: string;
}

/** Identifies an empty workbench window. */
export interface IEmptyWorkspaceIdentifier extends IBaseWorkspaceIdentifier {
}

/** Identifies a workbench opened on one folder. */
export interface ISingleFolderWorkspaceIdentifier
	extends IBaseWorkspaceIdentifier {
	readonly uri: URI;
}

/** Identifies a workbench opened from a multi-root workspace file. */
export interface IWorkspaceIdentifier extends IBaseWorkspaceIdentifier {
	readonly configPath: URI;
}

/** Identifies the workspace, folder, or empty context hosted by one window. */
export type IAnyWorkspaceIdentifier =
	| IWorkspaceIdentifier
	| ISingleFolderWorkspaceIdentifier
	| IEmptyWorkspaceIdentifier;

/** A folder belonging to the current resolved workspace. */
export interface IWorkspaceFolder {
	readonly id: string;
	readonly uri: URI;
	readonly name: string;
	readonly index: number;
}

/**
 * The resolved workspace visible to workbench contributions.
 *
 * Resource URIs are identities only. Filesystem access and workspace-boundary
 * authorization remain outside the renderer.
 */
export interface IWorkspace {
	readonly id: string;
	readonly folders: readonly IWorkspaceFolder[];
	readonly configuration?: URI;
	readonly name?: string;
}

/** Converts a persisted workspace identity into its minimal resolved projection. */
export function workspaceFromIdentifier(identifier: IAnyWorkspaceIdentifier): IWorkspace {
	if (isWorkspaceIdentifier(identifier)) {
		return freezeWorkspace({
			id: identifier.id,
			folders: [],
			configuration: identifier.configPath,
			name: workspaceName(identifier.configPath),
		});
	}
	if (isSingleFolderWorkspaceIdentifier(identifier)) {
		return freezeWorkspace({
			id: identifier.id,
			folders: [{ id: identifier.id, uri: identifier.uri, name: resourceName(identifier.uri), index: 0 }],
		});
	}
	return freezeWorkspace({ id: identifier.id, folders: [] });
}

/** One atomic replacement of the workspace hosted by a window. */
export interface IWorkspaceChangeEvent {
	readonly previous: IWorkspace;
	readonly workspace: IWorkspace;
}

/** Live workspace identity available to workbench contributions. */
export interface IWorkspaceContextService {
	readonly onDidChangeWorkspace: Event<IWorkspaceChangeEvent>;
	getWorkspace(): IWorkspace;
	getWorkbenchState(): WorkbenchState;
}

/** Returns the durable path that reopens the current folder or workspace file. */
export function workspaceOpenTarget(workspace: IWorkspace): string | undefined {
	const resource = workspace.configuration ?? (workspace.folders.length === 1 ? workspace.folders[0]?.uri : undefined);
	if (!resource) return undefined;
	return isRemoteResource(resource) ? getRemoteWorkspacePath(resource) : resource.fsPath;
}

export const IWorkspaceContextService =
	createServiceIdentifier<IWorkspaceContextService>(
		"workspaceContextService",
	);

/** Fallback identity for a window whose durable empty-workspace ID is unknown. */
export const UNKNOWN_EMPTY_WINDOW_WORKSPACE: IEmptyWorkspaceIdentifier =
	Object.freeze({ id: "empty-window" });

/** Returns whether a value identifies one folder. */
export function isSingleFolderWorkspaceIdentifier(
	value: unknown,
): value is ISingleFolderWorkspaceIdentifier {
	const candidate = value as Partial<ISingleFolderWorkspaceIdentifier> | null;
	return isNonEmptyString(candidate?.id) && candidate?.uri instanceof URI;
}

/** Returns whether a window is backed by a folder hosted through Remote. */
export function isRemoteWorkspaceIdentifier(value: unknown): value is ISingleFolderWorkspaceIdentifier {
	return isSingleFolderWorkspaceIdentifier(value) && isRemoteResource(value.uri);
}

/** Returns whether a value identifies a multi-root workspace file. */
export function isWorkspaceIdentifier(
	value: unknown,
): value is IWorkspaceIdentifier {
	const candidate = value as Partial<IWorkspaceIdentifier> | null;
	return isNonEmptyString(candidate?.id) &&
		candidate?.configPath instanceof URI;
}

/** Returns whether a value identifies an empty workbench. */
export function isEmptyWorkspaceIdentifier(
	value: unknown,
): value is IEmptyWorkspaceIdentifier {
	const candidate = value as Partial<IEmptyWorkspaceIdentifier> | null;
	return isNonEmptyString(candidate?.id) &&
		!isSingleFolderWorkspaceIdentifier(value) &&
		!isWorkspaceIdentifier(value);
}

/** Derives workbench state without storing a second workspace discriminator. */
export function workbenchStateFromWorkspaceIdentifier(
	workspace: IAnyWorkspaceIdentifier,
): WorkbenchState {
	if (isWorkspaceIdentifier(workspace)) {
		return WorkbenchState.WORKSPACE;
	}
	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return WorkbenchState.FOLDER;
	}
	return WorkbenchState.EMPTY;
}

/** Converts a workspace identity into an IPC-safe plain object. */
export function serializeWorkspaceIdentifier(
	workspace: IAnyWorkspaceIdentifier,
): unknown {
	if (isWorkspaceIdentifier(workspace)) {
		return {
			id: workspace.id,
			configPath: workspace.configPath.toString(),
		};
	}
	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return {
			id: workspace.id,
			uri: workspace.uri.toString(),
		};
	}
	return { id: workspace.id };
}

/** Validates and revives a workspace identity received over IPC. */
export function parseWorkspaceIdentifier(
	value: unknown,
): IAnyWorkspaceIdentifier {
	const record = exactRecord(value);
	const id = nonEmptyString(record.id, "workspace id");
	if ("configPath" in record) {
		requireExactKeys(record, ["configPath", "id"]);
		return Object.freeze({
			id,
			configPath: fileWorkspaceConfigUri(record.configPath, "workspace config path"),
		});
	}
	if ("uri" in record) {
		requireExactKeys(record, ["id", "uri"]);
		return Object.freeze({
			id,
			uri: workspaceResourceUri(record.uri, "workspace folder uri"),
		});
	}
	requireExactKeys(record, ["id"]);
	return id === UNKNOWN_EMPTY_WINDOW_WORKSPACE.id
		? UNKNOWN_EMPTY_WINDOW_WORKSPACE
		: Object.freeze({ id });
}

/** Derives workbench state from an already resolved workspace projection. */
export function workbenchStateFromWorkspace(workspace: IWorkspace): WorkbenchState {
	if (workspace.configuration) return WorkbenchState.WORKSPACE;
	if (workspace.folders.length === 1) return WorkbenchState.FOLDER;
	return WorkbenchState.EMPTY;
}

/** Converts a resolved workspace projection into an IPC-safe plain object. */
export function serializeWorkspace(workspace: IWorkspace): unknown {
	return {
		id: workspace.id,
		folders: workspace.folders.map(folder => ({
			id: folder.id,
			uri: folder.uri.toString(),
			name: folder.name,
			index: folder.index,
		})),
		...(workspace.configuration ? { configuration: workspace.configuration.toString() } : {}),
		...(workspace.name ? { name: workspace.name } : {}),
	};
}

/** Validates and revives a resolved workspace projection received over IPC. */
export function parseWorkspace(value: unknown): IWorkspace {
	const record = exactRecord(value);
	const expected = ['folders', 'id'];
	if ('configuration' in record) expected.push('configuration');
	if ('name' in record) expected.push('name');
	requireExactKeys(record, expected.sort());
	const id = nonEmptyString(record.id, 'workspace id');
	if (!Array.isArray(record.folders)) throw new Error('workspace folders must be an array');
	const folders = record.folders.map((value, index) => parseWorkspaceFolder(value, index));
	if (folders.length > 256) throw new Error('workspace folders must contain at most 256 entries');
	const identities = new Set<string>();
	for (const folder of folders) {
		const identity = folder.uri.toString();
		if (identities.has(identity)) throw new Error(`workspace folder URI is duplicated: ${identity}`);
		identities.add(identity);
	}
	const configuration = record.configuration === undefined
		? undefined
		: fileWorkspaceConfigUri(record.configuration, 'workspace configuration');
	const name = record.name === undefined ? undefined : nonEmptyString(record.name, 'workspace name');
	return freezeWorkspace({ id, folders, ...(configuration ? { configuration } : {}), ...(name ? { name } : {}) });
}

function exactRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("workspace identifier must be an object");
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const actual = Object.keys(value).sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(
			`workspace identifier must contain exactly: ${expected.join(", ")}`,
		);
	}
}

function workspaceResourceUri(value: unknown, field: string): URI {
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string`);
	}
	const uri = URI.parse(value);
	if (uri.query || uri.fragment) {
		throw new Error(`${field} must not contain a query or fragment`);
	}
	if (uri.scheme === "file") return uri;
	if (isRemoteResource(uri)) {
		getRemoteWorkspacePath(uri);
		return uri;
	}
	throw new Error(`${field} must use the file or ash-remote scheme`);
}

function fileWorkspaceConfigUri(value: unknown, field: string): URI {
	const uri = workspaceResourceUri(value, field);
	if (uri.scheme !== "file") throw new Error(`${field} must use the file scheme`);
	return uri;
}

function nonEmptyString(value: unknown, field: string): string {
	if (!isNonEmptyString(value)) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function parseWorkspaceFolder(value: unknown, expectedIndex: number): IWorkspaceFolder {
	const record = exactRecord(value);
	requireExactKeys(record, ['id', 'index', 'name', 'uri']);
	if (record.index !== expectedIndex) throw new Error('workspace folder indices must be contiguous and ordered');
	return Object.freeze({
		id: nonEmptyString(record.id, 'workspace folder id'),
		uri: workspaceResourceUri(record.uri, 'workspace folder URI'),
		name: nonEmptyString(record.name, 'workspace folder name'),
		index: expectedIndex,
	});
}

function freezeWorkspace(workspace: IWorkspace): IWorkspace {
	return Object.freeze({
		...workspace,
		folders: Object.freeze(workspace.folders.map(folder => Object.freeze({ ...folder }))),
	});
}

function workspaceName(configPath: URI): string {
	const name = resourceName(configPath);
	for (const extension of ['.ash-workspace', '.code-workspace']) {
		if (name.toLowerCase().endsWith(extension)) return name.slice(0, -extension.length) || name;
	}
	return name;
}

function resourceName(resource: URI): string {
	const path = decodeURIComponent(resource.path).replace(/\/+$/, '');
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name || resource.authority || resource.toString();
}
