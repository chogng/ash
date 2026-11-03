import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { buildAgentHostSessionWorkspace, selectionFromResource } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { SessionExecutionTarget, SessionWorkspaceSelection } from '../common/session.js';

/** Stores the last folder selected in Agents per provider. */
export class SessionsRecentWorkspacesService {
	constructor(@IStorageService private readonly storage: IStorageService) { }

	public getSelected(providerId: string, current: SessionWorkspaceSelection): SessionExecutionTarget | undefined {
		const value = this.storage.get(this.selectedKey(providerId), StorageScope.PROFILE);
		if (!value) return undefined;
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
}
