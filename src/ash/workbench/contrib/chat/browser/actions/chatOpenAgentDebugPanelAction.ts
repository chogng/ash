import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { URI } from '../../../../../base/common/uri.js';
import { ResumeAgentTraceCommandId, createAgentTraceInput, readLastAgentTraceResource, rememberAgentTraceResource, OpenAgentTraceCommandId, createAgentTraceResource, type AgentTraceLocation } from '../chatDebug/chatDebugEditorInput.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

/** Registers explicit commands for opening and resuming Agent Debug Logs. */
export function registerChatOpenAgentDebugPanelAction(): void {
	registerAction2(class OpenAgentDebugPanelForSessionAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.openAgentDebugPanelForSession', title: localize2('chatDebug.showForSession', 'Show Agent Debug Logs'), f1: true });
		}
		override async run(accessor: ServicesAccessor, target?: string | AgentTraceLocation, filter?: string): Promise<void> {
			const location = target ?? accessor.get(IChatSessionNavigationService).getActiveConversation();
			await openAgentTrace(accessor, createAgentTraceResource(location && filter !== undefined ? { ...(typeof location === 'string' ? { sessionId: location } : location), filter, viewHint: 'logs' } : location));
		}
	});

	registerAction2(class OpenAgentTrace extends Action2 {
		constructor() {
			super({
				id: OpenAgentTraceCommandId,
				title: localize2('agentTrace.openViewer', 'Open Agent Debug Logs'),
				category: localize2('debugLogs.developer', 'Developer'),
				f1: true,
			});
		}

		public override async run(accessor: ServicesAccessor, target?: string | AgentTraceLocation): Promise<void> {
			await openAgentTrace(accessor, createAgentTraceResource(target));
		}
	});

	async function openAgentTrace(accessor: ServicesAccessor, resource: URI): Promise<void> {
		const storage = accessor.get(IStorageService);
		const editors = accessor.get(IEditorService);
		await editors.openEditor(createAgentTraceInput(resource), { pinned: true });
		rememberAgentTraceResource(storage, resource);
	}

	registerAction2(class ResumeAgentTrace extends Action2 {
		constructor() { super({ id: ResumeAgentTraceCommandId, title: localize2('agentTrace.resume', 'Resume Agent Debug Logs'), f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await openAgentTrace(accessor, readLastAgentTraceResource(accessor.get(IStorageService)) ?? createAgentTraceResource());
		}
	});

}
