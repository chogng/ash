import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { isRecord } from "../../../../base/common/types.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IRecentWorkspacesService, type IRecentWorkspace } from "../common/recentWorkspacesService.js";
import type { IWorkspaceOpenService } from "./workspaceOpenService.js";

const RECENT_WORKSPACES_STORAGE_KEY = "workbench.recentWorkspaces";

/** Maximum number of projects retained in the profile-level Recent list. */
export const MAX_RECENT_WORKSPACES = 12;

interface PersistedRecentWorkspace {
	readonly name: string;
	readonly root: string;
	readonly lastOpened: number;
}

/**
 * Persists local folder workspaces at profile scope and keeps the welcome page
 * synchronized with host-authoritative workspace transitions.
 */
export class RecentWorkspacesService extends Disposable implements IRecentWorkspacesService {
	private readonly _onDidChange = this._register(new Emitter<readonly IRecentWorkspace[]>());
	private readonly storageService: IStorageService;
	private readonly workspaceContextService: IWorkspaceContextService;
	private readonly workspaceOpenService: IWorkspaceOpenService;
	private entries: readonly PersistedRecentWorkspace[];

	readonly onDidChange = this._onDidChange.event;

	constructor(storageService: IStorageService, workspaceContextService: IWorkspaceContextService, workspaceOpenService: IWorkspaceOpenService) {
		super();
		this.storageService = storageService;
		this.workspaceContextService = workspaceContextService;
		this.workspaceOpenService = workspaceOpenService;
		this.entries = readEntries(storageService.get(RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE));
		this._register(workspaceContextService.onDidChangeWorkspace(() => this.recordCurrentWorkspace()));
		this.recordCurrentWorkspace();
	}

	get recentWorkspaces(): readonly IRecentWorkspace[] {
		return Object.freeze(this.entries.map(toRecentWorkspace));
	}

	openWorkspace(root: string): Promise<void> {
		return this.workspaceOpenService.openWorkspace(root);
	}

	private recordCurrentWorkspace(): void {
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace.configuration?.scheme === "file") {
			this.record({
				name: workspace.name || resourceName(workspace.configuration.fsPath),
				root: workspace.configuration.fsPath,
				lastOpened: Date.now(),
			});
			return;
		}
		if (workspace.folders.length !== 1) return;
		const folder = workspace.folders[0];
		if (!folder || folder.uri.scheme !== "file") return;
		const root = folder.uri.fsPath;
		if (!root) return;
		this.record({
			name: folder.name || resourceName(root),
			root,
			lastOpened: Date.now(),
		});
	}

	private record(nextEntry: PersistedRecentWorkspace): void {
		this.entries = Object.freeze([
			nextEntry,
			...this.entries.filter(entry => entry.root !== nextEntry.root),
		].slice(0, MAX_RECENT_WORKSPACES));
		this.storageService.store(
			RECENT_WORKSPACES_STORAGE_KEY,
			JSON.stringify(this.entries),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
		this._onDidChange.fire(this.recentWorkspaces);
	}
}

function readEntries(value: string | undefined): readonly PersistedRecentWorkspace[] {
	if (!value) return [];
	try {
		const candidate: unknown = JSON.parse(value);
		if (!Array.isArray(candidate)) return [];
		const entries: PersistedRecentWorkspace[] = [];
		const roots = new Set<string>();
		for (const value of candidate) {
			if (!isRecord(value)) continue;
			const root = typeof value.root === "string" ? value.root.trim() : "";
			const name = typeof value.name === "string" ? value.name.trim() : "";
			const lastOpened = typeof value.lastOpened === "number" && Number.isFinite(value.lastOpened) ? value.lastOpened : 0;
			if (!root || roots.has(root)) continue;
			roots.add(root);
			entries.push({ name: name || resourceName(root), root, lastOpened });
		}
		entries.sort((left, right) => right.lastOpened - left.lastOpened);
		return Object.freeze(entries.slice(0, MAX_RECENT_WORKSPACES));
	} catch {
		return [];
	}
}

function toRecentWorkspace(entry: PersistedRecentWorkspace): IRecentWorkspace {
	return { name: entry.name, path: entry.root, root: entry.root };
}

function resourceName(root: string): string {
	const normalized = root.replace(/[\\/]+$/, "");
	const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	return normalized.slice(separator + 1) || normalized;
}
