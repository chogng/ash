import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import type { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IChatService, type ChatMode } from '../../../../workbench/services/chat/common/chatService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { selectionFromResource } from '../../../common/agentHostSessionWorkspace.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

registerAction2(class CompareAgentsAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.chat.compareAgents',
			title: localize2('sessions.chat.compareAgents', 'Compare Agents…'),
			f1: true,
			precondition: ContextKeyExpr.and(SessionsWorkspaceModeContext.isEqualTo('code'), ContextKeyExpr.not(`config.${ChatAIDisabledSettingId}`)),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const views = accessor.get(ISessionsService);
		const sessions = accessor.get(ISessionsManagementService);
		const providers = accessor.get(ISessionsProvidersService);
		const groups = accessor.get(ISessionGroupsService);
		const scopes = accessor.get(ISessionProviderScopeService);
		const chat = accessor.get(IChatService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const log = accessor.get(ILogService);
		const configuration = accessor.get(IConfigurationService);
		const source = views.activeSelection;
		if (source?.kind !== 'session' || source.active.session.status !== 'active') {
			notifications.warn(localize('sessions.compare.openChat', 'Open an active conversation to compare agents.'));
			return;
		}
		const { session, threadId } = source.active;
		const revision = views.navigationRevision;
		const provider = session.providerId && providers.getProvider(session.providerId);
		if (!provider || configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;

		const agents = await provider.listAgents();
		if (views.navigationRevision !== revision) return;
		if (agents.length < 2) {
			notifications.warn(localize('sessions.compare.needAgents', 'This host needs at least two configured agents to compare.'));
			return;
		}
		const selected = await pickItems(quickInput, agents.map(agent => ({
			label: agent.name, description: agent.sourceId, detail: agent.description, agent,
		})), localize('sessions.compare.pickAgents', 'Select at least two agents. Press Space to toggle and Enter to continue.'), 2);
		if (!selected || views.navigationRevision !== revision) return;
		const modes: readonly (IQuickPickItem & { readonly mode: ChatMode; })[] = [
			{ label: localize('sessions.compare.answers', 'Compare answers'), detail: localize('sessions.compare.answersDetail', 'Use Ask mode for investigation and answers.'), mode: 'ask' },
			{ label: localize('sessions.compare.code', 'Compare code changes'), detail: localize('sessions.compare.codeDetail', 'Run each agent in its own Git worktree.'), mode: 'agent' },
		];
		const execution = (await pickItems(quickInput, modes, localize('sessions.compare.pickMode', 'Choose how the agents should run')))?.[0];
		if (!execution || views.navigationRevision !== revision) return;
		const task = await quickInput.input({
			title: localize('sessions.compare.taskTitle', 'Task for all selected agents'),
			placeHolder: localize('sessions.compare.taskPrompt', 'Each agent receives this task and the source conversation’s text history.'),
			validateInput: async value => value.trim() ? undefined : localize('sessions.compare.emptyTask', 'Enter a task.'),
		});
		if (!task?.trim() || views.navigationRevision !== revision || configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;

		const snapshot = await chat.readThread(session.sessionId, threadId);
		if (views.navigationRevision !== revision || providers.getProvider(provider.id) !== provider || configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const isolated = execution.mode === 'agent';
		if (isolated && !snapshot.directory) {
			notifications.warn(localize('sessions.compare.gitRequired', 'Code comparison requires a conversation with a Git workspace.'));
			return;
		}
		// The Session workspace is the creation source. The hydrated Thread directory
		// can already be a managed checkout that cannot be selected as a new source.
		const workspace = !isolated && session.workspace ? selectionFromResource(sessionWorkspaceUri(session.workspace)) : { type: 'current' as const };
		const history = !isolated && snapshot.thread.turns.flatMap(turn => turn.items.flatMap(item => {
			switch (item.type) {
				case 'userMessage': return [localize('sessions.compare.userMessage', 'User: {0}', item.text)];
				case 'agentMessage': return [localize('sessions.compare.agentMessage', 'Agent: {0}', item.text)];
				case 'userContext': return [localize('sessions.compare.contextMessage', 'Attachment ({0}): {1}', item.name, item.content)];
				default: return [];
			}
		})).join('\n\n');
		const contexts = history ? [{ name: localize('sessions.compare.history', 'Source conversation'), content: history }] : undefined;
		const batch = createUuid();
		const report = (name: string, error: unknown) => {
			log.error('sessions.chat.compareAgents', 'Agent comparison failed', error);
			notifications.error(localize('sessions.compare.failed', '{0}: {1}', name, String(error)));
		};
		const threadService = isolated ? scopes.getScope(session.sessionId).thread : undefined;
		const results = await Promise.all(selected.map(async ({ agent }, index) => {
			const title = localize('sessions.compare.attemptTitle', 'Attempt {0} · {1}', index + 1, agent.name);
			let draftId: string | undefined;
			try {
				let targetSession: string;
				let targetThread: string;
				if (threadService) {
					// The same history sequence selects the same sealed repository trees for every fork.
					const fork = await threadService.fork({
						sessionId: session.sessionId, threadId, title, target: 'session',
						commandId: `compare-${batch}-${index + 1}`,
						comparison: { sourceSequence: snapshot.thread.sequence, agent, branchName: `ash/compare-${batch}-${index + 1}` },
					});
					targetSession = fork.sessionId;
					targetThread = fork.threadId;
				} else {
					const { untitledSessionId: id } = sessions.createUntitledSession(title, workspace, provider.id, false);
					draftId = id;
					sessions.setUntitledSessionAgent(id, agent);
					const target = await sessions.materializeUntitledSession(id);
					sessions.promoteUntitledSession(id, target);
					draftId = undefined;
					targetSession = target.session.sessionId;
					targetThread = target.threadId;
				}
				// Admission is independent of which result pane is currently focused.
				const send = chat.readThread(targetSession, targetThread).then(({ thread }) => {
					if (!threadService && thread.turns.length) throw new Error(localize('sessions.compare.targetUsed', 'The comparison conversation already has a task.'));
					return chat.startTurn({
						sessionId: targetSession, threadId: targetThread, expectedSequence: thread.sequence,
						text: task, mode: execution.mode, contexts: threadService ? undefined : contexts, commandInterpretation: 'literal',
					});
				}).then(() => true, error => { report(agent.name, error); return false; });
				return { targetSession, targetThread, name: agent.name, send };
			} catch (error) {
				if (draftId) sessions.discardUntitledSession(draftId);
				report(agent.name, error);
				return undefined;
			}
		}));

		const targets = results.filter(result => result !== undefined);
		if (targets.length) {
			try {
				const title = task.trim().replace(/\s+/gu, ' ').slice(0, 96).trimEnd();
				const group = await groups.create(localize('sessions.compare.groupTitle', 'Compare · {0}', title), undefined, 'comparison');
				for (const { targetSession, name } of targets) {
					try { await groups.move(targetSession, group.sectionId); }
					catch (error) { report(name, error); }
				}
			} catch (error) {
				report(localize('sessions.compare.group', 'Comparison group'), error);
			}
		}

		// Sessions serializes navigation by revision. Present the targets in picker
		// order and stop opening panes if the user navigates while the batch runs.
		let expectedRevision = revision;
		for (const result of results) {
			if (views.navigationRevision !== expectedRevision) break;
			if (!result) continue;
			const { targetSession, targetThread, name } = result;
			try {
				await views.openThread(targetSession, targetThread, { sideBySide: true });
			} catch (error) {
				report(name, error);
				// A failed open consumed its own revision. Any further change belongs to another navigation.
				if (views.navigationRevision !== expectedRevision + 1) break;
				expectedRevision = views.navigationRevision;
				continue;
			}
			const active = views.activeSelection;
			if (active?.kind !== 'session' || active.active.session.sessionId !== targetSession || active.active.threadId !== targetThread) break;
			expectedRevision = views.navigationRevision;
		}
		const sent = (await Promise.all(results.map(result => result?.send))).filter(Boolean).length;
		if (sent) status(localize('sessions.compare.started', 'Comparison started for {0} agents.', sent));
	}
});

function pickItems<T extends IQuickPickItem>(quickInput: IQuickInputService, items: readonly T[], label: string, minimum = 1): Promise<readonly T[] | undefined> {
	const lifetime = new DisposableStore();
	return new Promise<readonly T[] | undefined>((resolve, reject) => {
		try {
			const picker = lifetime.add(quickInput.createQuickPick<T>());
			picker.items = items;
			picker.ariaLabel = picker.placeholder = label;
			picker.canSelectMany = minimum > 1;
			lifetime.add(picker.onDidAccept(() => {
				if (picker.selectedItems.length < minimum) {
					status(label);
					return;
				}
				resolve(picker.selectedItems);
				picker.hide();
			}));
			lifetime.add(picker.onDidHide(() => {
				resolve(undefined);
				lifetime.dispose();
			}));
			picker.show();
		} catch (error) {
			lifetime.dispose();
			reject(error);
		}
	});
}
