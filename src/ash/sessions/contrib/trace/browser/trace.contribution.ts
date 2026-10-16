import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AgentTraceOutput, IAgentTraceOutput } from './agentTraceOutput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { URI } from '../../../../base/common/uri.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { createAgentTraceInput, readLastAgentTraceResource, rememberAgentTraceResource } from '../../../../workbench/contrib/trace/common/trace.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { createAgentTraceResource, type AgentTraceLocation } from '../../../../workbench/contrib/trace/common/trace.js';
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

	public override async run(accessor: ServicesAccessor, target?: AgentTraceLocation): Promise<void> {
		await openTraceEntry(accessor, target ? createAgentTraceResource(target) : currentTraceResource(accessor));
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


registerAction2(class OpenTraceNavigation extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.trace', title: localize2('agentTrace.navigationTitle', 'Trace'), f1: true, icon: Lxicon.history,
		});
	}
	public override async run(accessor: ServicesAccessor, source?: unknown): Promise<void> {
		await openTraceEntry(accessor, readLastAgentTraceResource(accessor.get(IStorageService)) ?? currentTraceResource(accessor), source === 'restore' ? source : undefined);
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

async function openTraceEntry(accessor: ServicesAccessor, resource: URI, source?: 'restore'): Promise<void> {
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ISessionsLayoutService);
	await layout.openEntry({
		id: 'trace', activityContext: 'sessions.activity.traceSelected', content: 'editor',
		showEditorTabs: true, restoreCommand: 'sessions.open.trace', focus: 'editor',
		editorInput: createAgentTraceInput(resource),
	}, undefined, source ? { source } : undefined);
	rememberAgentTraceResource(storage, resource);
}

registerSingleton(IAgentTraceOutput, AgentTraceOutput, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.contrib.agentOutput', WorkbenchPhase.AfterRestored, accessor => accessor.get(IAgentTraceOutput));

registerAction2(class ShowAgentOutput extends Action2 {
	constructor() { super({ id: 'sessions.trace.showOutput', title: localize2('agentOutput.show', 'Show Agent Output'), f1: true, menu: { id: MenuId.ChatTitle, group: '2_trace', order: 1 } }); }
	public override run(accessor: ServicesAccessor): void { accessor.get(IAgentTraceOutput).showCurrent(); }
});
