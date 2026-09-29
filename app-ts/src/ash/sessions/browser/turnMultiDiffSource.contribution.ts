import type { IAction } from '../../base/common/actions.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { URI } from '../../base/common/uri.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../workbench/common/contributions.js';
import type { MultiDiffEditorInput } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IMultiDiffSourceResolverService, type IMultiDiffSourceResolver, type IResolvedMultiDiffSource } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { type IChatService, IChatService as ChatServiceId, type TurnChangeSetSummary } from '../../workbench/services/chat/common/chatService.js';
import { IEditorService, type IEditorService as IEditorServiceContract } from '../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { createTurnMultiDiffEditorInput, type TurnMultiDiffScope } from './turnMultiDiffSource.js';

class SessionsMultiDiffSourceResolver implements IMultiDiffSourceResolver {

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ChatServiceId private readonly chat: IChatService,
		@IEditorService private readonly editors: IEditorServiceContract,
	) {}

	sourceActions(): readonly IAction[] {
		const available = this.sessions.active !== undefined;
		return [
			this.action('multiDiff.source.currentTurn', 'Current Turn', 'Show the current Turn', available, () => this.openTurn('currentTurn')),
			this.action('multiDiff.source.throughCurrentTurn', 'Current Turn and Earlier', 'Show all changes through the current Turn', available, () => this.openTurn('throughCurrentTurn')),
			this.action('multiDiff.source.previousTurn', 'Previous Turn', 'Show the previous Turn', available, () => this.openTurn('previousTurn')),
		];
	}

	canHandleUri(uri: URI): boolean {
		return uri.scheme === 'ash-multi-diff' && uri.path.startsWith('/turn/');
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const identity = turnSourceIdentity(uri);
		if (!identity) throw new Error('The multi-diff source does not belong to Sessions.');
		const session = this.sessions.sessions.find(candidate => candidate.sessionId === identity.sessionId);
		if (!session) throw new Error('The Turn source Session is no longer available.');
		const input = await createTurnMultiDiffEditorInput(this.chat, { session, threadId: identity.threadId }, identity.scope, identity.changeSetIds);
		return { resource: input.resource, resources: input.items, label: input.label, source: input.source };
	}

	primaryRepositoryAction(input: MultiDiffEditorInput): IAction | undefined {
		if (!this.sessions.active || input.source?.kind !== 'external' || input.source.providerId !== 'sessions.turn') return undefined;
		return {
			id: 'multiDiff.commit.auto',
			label: 'Commit',
			tooltip: 'Generate a commit message and commit the selected Turn changes',
			icon: Lxicon.gitCommit,
			enabled: true,
			run: () => this.autoCommit(input),
		};
	}

	private action(id: string, label: string, tooltip: string, enabled: boolean, run: () => Promise<void>): IAction {
		return { id, label, tooltip, enabled, run };
	}

	private async openTurn(scope: TurnMultiDiffScope): Promise<void> {
		const active = this.sessions.active;
		if (!active) throw new Error('No active Turn is available.');
		const input = await createTurnMultiDiffEditorInput(this.chat, active, scope);
		await this.editors.openEditor(input, { pinned: true });
	}

	private async autoCommit(input: MultiDiffEditorInput): Promise<string> {
		const identity = turnSourceIdentity(input.resource);
		const active = this.sessions.active;
		const sessionId = identity?.sessionId ?? active?.session.sessionId;
		const threadId = identity?.threadId ?? active?.threadId;
		if (!sessionId || !threadId) throw new Error('No active Turn is available to commit.');
		const listed = await this.chat.listTurnChanges(sessionId, threadId);
		const requestedIds = identity ? new Set(identity.changeSetIds) : undefined;
		const selected = listed.filter(changeSet =>
			(requestedIds?.has(changeSet.changeSetId) ?? changeSet.repositoryId === input.source?.repositoryId) &&
			changeSet.captureState !== 'discarded' && changeSet.commitState !== 'committed');
		if (selected.length === 0) throw new Error('No sealed Turn changes are available to commit.');
		for (const changeSet of selected) await this.commitChangeSet(changeSet);
		return selected.length === 1 ? 'Committed the selected Turn.' : `Committed ${selected.length} Turns.`;
	}

	private async commitChangeSet(initial: TurnChangeSetSummary): Promise<void> {
		if (initial.captureState !== 'sealed') throw new Error('The selected Turn is still running and cannot be committed.');
		let summary = initial;
		let details = await this.chat.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId);
		if (!details.draftMessage?.trim()) {
			if (summary.messageState === 'unconfigured') throw new Error('Configure and authorize a commit-message model before using automatic commit.');
			const updates = await this.chat.generateTurnChangeMessage(summary.sessionId, summary.threadId, summary.changeSetId, summary.revision);
			summary = updates.find(candidate => candidate.changeSetId === summary.changeSetId) ?? summary;
			summary = await this.waitForGeneratedMessage(summary);
			details = await this.chat.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId);
			const message = details.draftMessage?.trim() || details.generatedMessage?.trim();
			if (!message) throw new Error('The commit-message model did not produce a message.');
			if (!details.draftMessage?.trim()) {
				const draftUpdates = await this.chat.updateTurnChangeDraft(summary.sessionId, summary.threadId, summary.changeSetId, summary.revision, message);
				summary = draftUpdates.find(candidate => candidate.changeSetId === summary.changeSetId) ?? summary;
			}
		}
		await this.chat.commitTurnChange(summary.sessionId, summary.threadId, summary.changeSetId, summary.revision);
	}

	private waitForGeneratedMessage(summary: TurnChangeSetSummary): Promise<TurnChangeSetSummary> {
		if (summary.messageState === 'ready') return Promise.resolve(summary);
		if (summary.messageState === 'failed' || summary.messageState === 'unconfigured') return Promise.reject(new Error('Commit-message generation failed.'));
		return new Promise((resolve, reject) => {
			const listener = this.chat.onDidUpdateTurnChanges(update => {
				if (update.sessionId !== summary.sessionId || update.threadId !== summary.threadId) return;
				const next = update.changeSets.find(candidate => candidate.changeSetId === summary.changeSetId);
				if (!next || next.messageState === 'queued' || next.messageState === 'generating') return;
				listener.dispose();
				if (next.messageState === 'ready') resolve(next);
				else reject(new Error('Commit-message generation failed.'));
			});
		});
	}
}

class SessionsMultiDiffSourceContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IMultiDiffSourceResolverService resolvers: IMultiDiffSourceResolverService,
	) {
		super();
		this._register(resolvers.registerResolver(instantiationService.createInstance(SessionsMultiDiffSourceResolver)));
	}
}

function turnSourceIdentity(uri: URI): {
	readonly scope: TurnMultiDiffScope;
	readonly sessionId: string;
	readonly threadId: string;
	readonly changeSetIds: readonly string[];
} | undefined {
	if (uri.scheme !== 'ash-multi-diff' || !uri.path.startsWith('/turn/')) return undefined;
	const scope = uri.path.split('/').at(-1);
	if (scope !== 'currentTurn' && scope !== 'throughCurrentTurn' && scope !== 'previousTurn') throw new Error('Invalid Turn source scope.');
	const query = new URLSearchParams(uri.toEncodedComponents().query);
	const sessionId = query.get('session');
	const threadId = query.get('thread');
	const changes = query.get('changes');
	if (!sessionId || !threadId || !changes) throw new Error('Invalid Turn source identity.');
	return { scope, sessionId, threadId, changeSetIds: changes.split(',') };
}

registerWorkbenchContribution('sessions.contrib.multiDiffSource', WorkbenchPhase.BlockStartup,
	accessor => accessor.get(IInstantiationService).createInstance(SessionsMultiDiffSourceContribution));
