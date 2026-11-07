import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IAgentSession } from './agentSessionsModel.js';

type FilterSelection = 'all' | 'running' | 'drafts' | 'pinned';

const filterStorageKey = 'chat.agentSessions.filter';

/** Owns the sidebar's filter preference. The search query belongs to the control. */
export class AgentSessionsFilter {
	private currentSelection: FilterSelection;

	constructor(@IStorageService private readonly storage: IStorageService) {
		const stored = storage.get(filterStorageKey, StorageScope.PROFILE);
		this.currentSelection = stored === 'running' || stored === 'drafts' || stored === 'pinned' ? stored : 'all';
	}

	get selection(): FilterSelection {
		return this.currentSelection;
	}

	setSelection(selection: FilterSelection): void {
		this.currentSelection = selection;
		this.storage.store(filterStorageKey, selection, StorageScope.PROFILE, StorageTarget.USER);
	}

	isDefault(): boolean {
		return this.currentSelection === 'all';
	}

	exclude(session: IAgentSession): boolean {
		switch (this.currentSelection) {
			case 'all': return false;
			case 'running': return session.inProgress !== true;
			case 'drafts': return session.kind !== 'draft';
			case 'pinned': return !session.isPinned();
		}
	}
}
