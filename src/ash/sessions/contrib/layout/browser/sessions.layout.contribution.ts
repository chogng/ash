import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsEntryService, type ISessionsEntryOpenOptions } from '../../../services/layout/common/sessionsEntryService.js';
import { SESSIONS_NAVIGATION_CONTAINER_ID } from '../../sessions/browser/views/sessionsView.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { COLLAB_CONTAINER_ID } from '../../../../workbench/contrib/collab/common/collab.js';
import { SessionsEntryService, documentEntry } from './sessionsEntryService.js';
import { ISessionEditorWorkingSetService, SessionEditorWorkingSetService } from '../common/sessionEditorWorkingSet.js';

class SessionsLayoutContribution extends Disposable {
	constructor(@ISessionsEntryService layout: ISessionsEntryService) {
		super();
		this._register(CommandsRegistry.register('sessions.open.code', (_accessor, source) => {
			const options: ISessionsEntryOpenOptions | undefined = source === 'conversation' ? { focus: 'conversation' } : source === 'restore' ? { source } : undefined;
			return layout.openEntry(documentEntry, undefined, options);
		}));
		// Retire the saved sidebar entry; explicit legacy commands now open its Settings owner.
		this._register(CommandsRegistry.register('sessions.open.teams', async (accessor, source) => {
			await layout.openEntry(documentEntry, undefined, source === 'restore' ? { source } : undefined);
			if (source !== 'restore') await accessor.get(IPreferencesService).openUserSettings({ section: 'agents' });
		}));
		for (const [id, sidebar, focus] of [
			['chat', SESSIONS_NAVIGATION_CONTAINER_ID, 'conversation'],
			['collaboration', COLLAB_CONTAINER_ID, 'sidebar'],
		] as const) {
			this._register(CommandsRegistry.register('sessions.open.' + id, (_accessor, source) => layout.openEntry({
				id, workspaceMode: id === 'chat' ? 'chat' : 'current', sidebarContainerId: sidebar, content: 'conversation', focus,
				conversationKind: 'chat',
				newDraft: id === 'chat' ? 'conversation' : undefined,
				activityContext: 'sessions.activity.' + id + 'Selected', restoreCommand: 'sessions.open.' + id,
			}, undefined, source === 'restore' ? { source } : undefined)));
		}
	}
}

registerSingleton(ISessionsEntryService, SessionsEntryService, InstantiationType.Delayed);
registerSingleton(ISessionEditorWorkingSetService, SessionEditorWorkingSetService, InstantiationType.Delayed);
registerWorkbenchContribution('workbench.contrib.sessionsLayout', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(SessionsLayoutContribution));
