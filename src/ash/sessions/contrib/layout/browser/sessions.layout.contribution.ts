import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { SESSIONS_NAVIGATION_CONTAINER_ID, TEAMS_NAVIGATION_CONTAINER_ID } from '../../../browser/parts/sidebarPart.js';
import { COLLAB_CONTAINER_ID } from '../../../../workbench/contrib/collab/common/collab.js';
import { SessionsLayoutService, documentEntry } from './sessionsLayoutService.js';

class SessionsLayoutContribution extends Disposable {
	constructor(@ISessionsLayoutService layout: ISessionsLayoutService) {
		super();
		this._register(
			CommandsRegistry.register('sessions.open.code', (_accessor, source) =>
				layout.openEntry(documentEntry, undefined, source === 'restore' ? { source } : undefined),
			),
		);
		for (const [id, sidebar, focus] of [
			['chat', SESSIONS_NAVIGATION_CONTAINER_ID, 'conversation'],
			['teams', TEAMS_NAVIGATION_CONTAINER_ID, 'sidebar'],
			['collaboration', COLLAB_CONTAINER_ID, 'sidebar'],
		] as const) {
			this._register(
				CommandsRegistry.register('sessions.open.' + id, (_accessor, source) =>
					layout.openEntry(
						{
							id,
							workspaceMode: id === 'chat' ? 'chat' : 'code',
							sidebarContainerId: sidebar,
							content: 'conversation',
							focus,
							activityContext: 'sessions.activity.' + id + 'Selected',
							restoreCommand: 'sessions.open.' + id,
						},
						undefined,
						source === 'restore' ? { source } : undefined,
					),
				),
			);
		}
	}
}

registerSingleton(ISessionsLayoutService, SessionsLayoutService, InstantiationType.Delayed);
registerWorkbenchContribution('workbench.contrib.sessionsLayout', WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(SessionsLayoutContribution),
);
