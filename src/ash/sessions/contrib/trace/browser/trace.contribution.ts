import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { URI } from '../../../../base/common/uri.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { createAgentTraceInput, readLastAgentTraceResource, rememberAgentTraceResource } from '../../../../workbench/contrib/trace/common/trace.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { createAgentTraceResource } from '../../../../workbench/contrib/trace/common/trace.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { AgentTreeNode } from '../../../services/sessions/common/session.js';

registerAction2(class OpenAgentTrace extends Action2 {
	constructor() {
		super({
			id: 'sessions.trace.open',
			title: localize2('agentTrace.open', 'View Execution Trace'),
			f1: true,
			icon: Lxicon.history,
			menu: { id: MenuId.ChatTitle, group: 'navigation', order: 3 },
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		await openTraceEntry(accessor, currentTraceResource(accessor));
	}
});

function findTurn(nodes: readonly AgentTreeNode[], threadId: string): string | undefined {
	for (const node of nodes) {
		if (node.threadId === threadId) { return node.currentTurnId; }
		const turnId = findTurn(node.children, threadId);
		if (turnId) { return turnId; }
	}
	return undefined;
}


const TraceNavigationContainerId = 'sessions.navigation.trace';
let navigationRegistration: Promise<void> | undefined;
function ensureTraceNavigation(): Promise<void> {
	return navigationRegistration ??= import('../../../../workbench/contrib/trace/browser/agentTraceNavigation.js').then(({ AgentTraceNavigationView }) => {
		SessionsViewRegistry.registerStaticViewContainer({ id: TraceNavigationContainerId, title: 'Trace', localizationKey: { bundle: 'ash', key: 'agentTrace.navigationTitle' }, location: ViewContainerLocation.Sidebar, mergeViewWithContainerWhenSingleView: true, order: 6 });
		SessionsViewRegistry.registerStaticViews(TraceNavigationContainerId, [{ id: TraceNavigationContainerId + '.view', title: 'Trace', localizationKey: { bundle: 'ash', key: 'agentTrace.navigationTitle' }, canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(AgentTraceNavigationView, [{ resume: 'sessions.open.trace', offline: 'sessions.trace.import', current: 'sessions.trace.open' }]) }]);

	}).catch(error => { navigationRegistration = undefined; throw error; });
}

registerAction2(class OpenTraceNavigation extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.trace', title: localize2('agentTrace.navigationTitle', 'Trace'), f1: true, icon: Lxicon.history,
			toggled: ContextKeyExpr.has('sessions.activity.traceSelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 60, when: ContextKeyExpr.has('sessions.traceAvailable') }
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await openTraceEntry(accessor, readLastAgentTraceResource(accessor.get(IStorageService)) ?? currentTraceResource(accessor));
	}
});

registerAction2(class ImportTraceNavigation extends Action2 {
	constructor() { super({ id: 'sessions.trace.import', title: localize2('agentTrace.offline', 'Open offline capture'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> { await openTraceEntry(accessor, createAgentTraceResource()); }
});

function currentTraceResource(accessor: ServicesAccessor): URI {
	const active = accessor.get(ISessionsService).activeSelection;
	return createAgentTraceResource(active?.kind === 'session' ? {
		sessionId: active.active.session.sessionId, threadId: active.active.threadId,
		turnId: findTurn(active.active.session.agentTree ?? [], active.active.threadId),
	} : undefined);
}

async function openTraceEntry(accessor: ServicesAccessor, resource: URI): Promise<void> {
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ISessionsLayoutService);
	const contextKeys = accessor.get(IContextKeyService);
	await ensureTraceNavigation();
	contextKeys.createKey<boolean>('sessions.traceAvailable', true).set(true);
	await layout.openEntry({
		id: 'trace', activityContext: 'sessions.activity.traceSelected', content: 'editor',
		sidebarContainerId: TraceNavigationContainerId, restoreCommand: 'sessions.open.trace', focus: 'editor',
		editorInput: createAgentTraceInput(resource),
	});
	rememberAgentTraceResource(storage, resource);
}
