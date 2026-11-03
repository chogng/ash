import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { buildAgentHostSessionWorkspace, selectionFromResource } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { SessionExecutionTarget, SessionWorkspaceSelection } from '../common/session.js';

const storageKey = 'sessions.hiddenRecentWorkspaces';

/** Stores Agents picker preferences separately from the Workbench's shared recent-folder history. */
export class SessionsRecentWorkspacesService {
	constructor(@IStorageService private readonly storage: IStorageService) { }

	public getSelected(providerId: string, current: SessionWorkspaceSelection): SessionExecutionTarget | undefined {
		const value = this.storage.get(this.selectedKey(providerId), StorageScope.PROFILE);
		if (!value || this.readHidden().has(value)) return undefined;
		try {
			const folder = URI.parse(value, true);
			if (folder.scheme !== Schemas.file && folder.scheme !== Schemas.ashRemote) return undefined;
			const target = selectionFromResource(folder);
			if (current.type === 'ssh') return target.type === 'ssh' && target.host === current.host ? target : undefined;
			if (current.type === 'remote') return target.type === 'remote' && target.authority === current.authority ? target : undefined;
			if (current.type === 'provider') return undefined;
			return target.type === 'local' && folder.scheme === Schemas.file ? target : undefined;
		} catch {
			return undefined;
		}
	}

	public setSelected(providerId: string, target: SessionExecutionTarget): void {
		const folder = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
		this.storage.store(this.selectedKey(providerId), folder.toString(), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private selectedKey(providerId: string): string {
		return `sessions.selectedRecentWorkspace.${providerId}`;
	}

	public getHidden(): ReadonlySet<string> {
		return this.readHidden();
	}

	public setHidden(folder: URI, hidden: boolean): void {
		const key = folder.toString();
		const folders = this.readHidden();
		if (folders.has(key) === hidden) return;
		if (hidden) folders.add(key);
		else folders.delete(key);
		if (folders.size) this.storage.store(storageKey, JSON.stringify([...folders]), StorageScope.PROFILE, StorageTarget.MACHINE);
		else this.storage.remove(storageKey, StorageScope.PROFILE);
	}

	private readHidden(): Set<string> {
		const stored = this.storage.get(storageKey, StorageScope.PROFILE);
		if (!stored) return new Set();
		try {
			const value: unknown = JSON.parse(stored);
			if (Array.isArray(value)) return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
		} catch {
			// Treat an unreadable filter as empty so the shared history is still usable.
		}
		return new Set();
	}
}
