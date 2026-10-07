import type { IAction } from '../../base/common/actions.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { localize } from '../../nls.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import type { URI } from '../../base/common/uri.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../workbench/common/contributions.js';
import type { MultiDiffEditorInput } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IMultiDiffSourceResolverService, type IMultiDiffSourceResolver, type IResolvedMultiDiffSource } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { type IChatService, IChatService as ChatServiceId, type TurnCommitSelection } from '../../workbench/services/chat/common/chatService.js';
import { IEditorService, type IEditorService as IEditorServiceContract } from '../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { createTurnCommitPreviewInput, createTurnMultiDiffEditorInput, type TurnMultiDiffScope } from './turnMultiDiffSource.js';

class SessionsMultiDiffSourceResolver implements IMultiDiffSourceResolver {

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ChatServiceId private readonly chat: IChatService,
		@IEditorService private readonly editors: IEditorServiceContract,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { }

	sourceActions(): readonly IAction[] {
		const available = this.sessions.active !== undefined;
		return [
			this.action('multiDiff.source.currentTurn', 'Current Turn', 'Show the current Turn', available, () => this.openTurn('currentTurn')),
			this.action('multiDiff.source.throughCurrentTurn', 'Current Turn and Earlier', 'Show all changes through the current Turn', available, () => this.openTurn('throughCurrentTurn')),
			this.action('multiDiff.source.previousTurn', 'Previous Turn', 'Show the previous Turn', available, () => this.openTurn('previousTurn')),
		];
	}

	canHandleUri(uri: URI): boolean {
		return uri.scheme === 'ash-multi-diff' && (uri.path.startsWith('/turn/') || uri.path.startsWith('/turn-commit/'));
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const preview = commitSourceIdentity(uri);
		if (preview) {
			const input = await createTurnCommitPreviewInput(this.chat, preview.sessionId, preview.threadId, await this.chat.readTurnCommit(preview.sessionId, preview.threadId, preview.commitId));
			return { resource: input.resource, resources: input.items, label: input.label, source: input.source };
		}
		const identity = turnSourceIdentity(uri);
		if (!identity) throw new Error('The multi-diff source does not belong to Sessions.');
		const session = this.sessions.sessions.find(candidate => candidate.sessionId === identity.sessionId);
		if (!session) throw new Error('The Turn source Session is no longer available.');
		const input = await createTurnMultiDiffEditorInput(this.chat, { session, threadId: identity.threadId }, identity.scope, identity.changeSetIds);
		return { resource: input.resource, resources: input.items, label: input.label, source: input.source };
	}

	primaryRepositoryAction(input: MultiDiffEditorInput): IAction | undefined {
		if (input.source?.kind !== 'external') { return undefined; }
		const preview = commitSourceIdentity(input.resource);
		if (preview && input.source.providerId === 'sessions.turnCommit') {
			return {
				id: 'multiDiff.commit.selection', label: localize('sessions.changes.commitPrepared', 'Commit this preview'), tooltip: localize('sessions.changes.commitPreparedHint', 'Commit exactly the reviewed files and message'), icon: Lxicon.gitCommit, enabled: true, run: async () => {
					await this.chat.commitTurnChange(preview.sessionId, preview.threadId, preview.commitId);
					return localize('sessions.changes.commitQueued', 'The reviewed commit is queued.');
				}
			};
		}
		if (input.source.providerId !== 'sessions.turn') { return undefined; }
		return { id: 'multiDiff.commit.preview', label: localize('sessions.changes.previewCommit', 'Preview commit…'), tooltip: localize('sessions.changes.previewCommitHint', 'Choose a message and review the remaining Turn changes before committing'), icon: Lxicon.gitCommit, enabled: true, run: () => this.previewCommit(input) };
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

	private async previewCommit(input: MultiDiffEditorInput): Promise<void> {
		const identity = turnSourceIdentity(input.resource);
		if (!identity) { throw new Error(localize('sessions.changes.invalidSelection', 'This review has no Turn selection.')); }
		const listed = await this.chat.listTurnChanges(identity.sessionId, identity.threadId);
		const selected = listed.filter(record => identity.changeSetIds.includes(record.changeSetId) && record.captureState === 'sealed' && record.commitState !== 'committed');
		const selections: TurnCommitSelection[] = [];
		let draft = '';
		for (const record of selected) {
			const details = await this.chat.readTurnChange(identity.sessionId, identity.threadId, record.changeSetId);
			const paths = details.files.filter(file => !details.summary.committedPaths.includes(file.path)).map(file => file.path);
			if (paths.length) { selections.push({ changeSetId: record.changeSetId, expectedRevision: details.summary.revision, paths }); }
			if (selected.length === 1) { draft = details.draftMessage ?? ''; }
		}
		if (!selections.length) { throw new Error(localize('sessions.changes.noSelection', 'Select sealed file changes that have not been committed.')); }
		const message = await this.quickInput.input({ title: localize('sessions.changes.commitMessage', 'Commit message'), value: draft, validateInput: async value => value.trim() ? undefined : localize('sessions.changes.messageRequired', 'Enter a commit message.') });
		if (message === undefined) { return; }
		const preview = await this.chat.prepareTurnCommit(identity.sessionId, identity.threadId, selections, message);
		await this.editors.openEditor(await createTurnCommitPreviewInput(this.chat, identity.sessionId, identity.threadId, preview), { pinned: true });
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

function commitSourceIdentity(uri: URI): { readonly sessionId: string; readonly threadId: string; readonly commitId: string; } | undefined {
	if (uri.scheme !== 'ash-multi-diff' || !uri.path.startsWith('/turn-commit/')) { return undefined; }
	const query = new URLSearchParams(uri.toEncodedComponents().query);
	const sessionId = query.get('session');
	const threadId = query.get('thread');
	const commitId = decodeURIComponent(uri.path.slice('/turn-commit/'.length));
	if (!sessionId || !threadId || !commitId) { throw new Error(localize('sessions.changes.invalidSelection', 'This review has no Turn selection.')); }
	return { sessionId, threadId, commitId };
}

// The resolver needs IEditorService, which the Workbench registers after BlockStartup.
registerWorkbenchContribution('sessions.contrib.multiDiffSource', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(SessionsMultiDiffSourceContribution));
