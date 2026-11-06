import type { ISessionsListTools } from '../../../services/appTools/browser/appTools.js';
import { ISessionGroupsService, type SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';

/** App tools operate on the same section model as the Sessions sidebar. */
export class SessionsListTools implements ISessionsListTools {
	constructor(
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@ISessionsListModelService private readonly list: ISessionsListModelService,
		@IContextKeyService private readonly contexts: IContextKeyService,
	) { }

	readTree(): ReturnType<ISessionsListTools['readTree']> {
		const mode = this.contexts.getValue(SessionsWorkspaceModeContext.key) === 'code' ? 'code' : 'chat';
		const sections = this.list.readTree(mode);
		if (sections) return { mode, sort: this.list.getSort(mode).field, automationSessions: this.list.automationSessionsMode, sections };
		return undefined;
	}

	listSections(): readonly SessionGroup[] {
		return this.groups.groups;
	}

	createSection(name: string, signal: AbortSignal): Promise<SessionGroup> {
		return this.groups.create(name, signal);
	}

	renameSection(sectionId: string, name: string, signal: AbortSignal): Promise<void> {
		return this.groups.rename(sectionId, name, signal);
	}

	deleteSection(sectionId: string, signal: AbortSignal): Promise<void> {
		return this.groups.delete(sectionId, signal);
	}

	moveSession(sessionId: string, sectionId: string | null, signal: AbortSignal): Promise<void> {
		return this.groups.move(sessionId, sectionId, signal);
	}

	reorderSection(sectionId: string, sessionIds: readonly string[], signal: AbortSignal): Promise<void> {
		return this.groups.reorder(sectionId, sessionIds, signal);
	}
}
