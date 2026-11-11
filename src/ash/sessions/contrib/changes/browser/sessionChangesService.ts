import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { constObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IChatService, type TurnCommitSelection } from '../../../../workbench/services/chat/common/chatService.js';
import { IDecorationsService } from '../../../../workbench/services/decorations/common/decorations.js';
import { IEditorService, type EditorOpenTarget } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import {
	createSessionFileChange, matchesSessionFileChange, SessionChangesetOperationScope, SessionChangesetOperationStatus,
	type ISessionChangeset, type ISessionFileChange,
} from '../../../services/sessions/common/session.js';
import { createTurnCommitPreviewInput } from '../../../browser/turnMultiDiffSource.js';
import { getCapturedTurnIds } from '../common/changes.js';
import type { ISessionChangesEditorOptions, ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';

/** Editor preferences and tab counts are presentation state; captures are always read from ChatService. */
export class SessionChangesService extends Disposable implements ISessionChangesService {
	private readonly counts = new Map<string, number>();
	private readonly decorationsChanged = this._register(new Emitter<readonly URI[]>());

	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IChatService private readonly chat: IChatService,
		@IDecorationsService decorations: IDecorationsService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
	) {
		super();
		this._register(decorations.registerDecorationsProvider({
			label: localize('sessions.changes.title', 'Changes'),
			onDidChange: this.decorationsChanged.event,
			provideDecorations: resource => {
				const count = this.counts.get(resource.toString());
				return count === undefined ? undefined : {
					letter: String(count), tooltip: localize('sessions.changes.count', '{0} changed files', count),
				};
			},
		}));
	}

	public getChangesEditorResource(sessionResource: URI): URI {
		return sessionResource.with({ scheme: 'ash-session-changes', fragment: '' });
	}

	public getSessionResource(editorResource: URI): URI | undefined {
		if (editorResource.scheme !== 'ash-session-changes' || !editorResource.path.startsWith('/') || editorResource.path.length < 2) { return undefined; }
		return editorResource.with({ scheme: 'ash-session', fragment: '' });
	}

	public async openChangesEditor(sessionResource: URI, options?: ISessionChangesEditorOptions, group?: EditorOpenTarget): Promise<IEditorGroup | undefined> {
		if (sessionResource.scheme !== 'ash-session') { throw new Error(localize('sessions.changes.invalidSelection', 'This review has no Turn selection.')); }
		if (!sessionResource.path.startsWith('/draft/')) { this.getConversation(sessionResource); }
		const input = new SessionChangesEditorInput(this.getChangesEditorResource(sessionResource), options?.changesetSelection);
		const selection = options?.selection;
		const selectionSource = options?.selectionSource;
		await this.editors.openEditor(input, {
			pinned: true, forceReload: options?.changesetSelection !== undefined || options?.forceReload,
			preserveFocus: options?.preserveFocus, revealIfOpened: options?.revealIfOpened,
			ignoreError: options?.ignoreError, source: options?.source, viewState: options?.viewState,
			selection: selection ? new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber ?? selection.startLineNumber, selection.endColumn ?? selection.startColumn) : undefined,
			selectionSource: selectionSource === TextEditorSelectionSource.PROGRAMMATIC || selectionSource === TextEditorSelectionSource.JUMP
				? selectionSource : selection ? TextEditorSelectionSource.NAVIGATION : undefined,
		}, group);
		return this.groups.groups.find(group => group.inputs.includes(input));
	}

	public async resolveChangeset(sessionResource: URI, id: string): Promise<ISessionChangeset> {
		const { sessionId, threadId } = this.getConversation(sessionResource);
		const details = await this.chat.readTurnChange(sessionId, threadId, id);
		const changes = details.files.map(file => createSessionFileChange(details.summary, file));
		const remaining = changes.filter(change => !details.summary.committedPaths.includes(change.file.path));
		const busy = details.summary.commitState === 'queued' || details.summary.commitState === 'committing';
		const status = details.summary.captureState !== 'sealed' || !remaining.length ? SessionChangesetOperationStatus.Disabled
			: busy ? SessionChangesetOperationStatus.Running : details.summary.commitState === 'failed' ? SessionChangesetOperationStatus.Error : SessionChangesetOperationStatus.Idle;
		return {
			id: details.summary.changeSetId, resource: this.getChangesEditorResource(sessionResource).with({ fragment: id }),
			label: localize('sessions.changes.turn', 'Turn {0}', details.summary.turnId),
			isEnabled: constObservable(details.summary.captureState !== 'discarded'), isDefault: constObservable(false),
			isLoadingChanges: constObservable(false), capabilities: { review: details.summary.captureState !== 'discarded' },
			changes: constObservable(changes),
			// Turn captures supply content snapshots rather than Git checkpoint references.
			originalCheckpointRef: constObservable(undefined),
			modifiedCheckpointRef: constObservable(undefined),
			operations: constObservable([{
				id: 'preview', label: localize('sessions.changes.previewCommit', 'Preview commit…'),
				scopes: [SessionChangesetOperationScope.Changeset, SessionChangesetOperationScope.Resource], status,
			}]),
			invokeOperation: async (operationId, target) => {
				const files = target ? remaining.filter(change => matchesSessionFileChange(change, target.resource)) : remaining;
				if (this.isDisposed || operationId !== 'preview' || status === SessionChangesetOperationStatus.Disabled || status === SessionChangesetOperationStatus.Running || !files.length) {
					throw new Error(localize('sessions.changes.noSelection', 'Select sealed file changes that have not been committed.'));
				}
				await this.openCommitPreview(sessionId, threadId, [{
					changeSetId: details.summary.changeSetId,
					expectedRevision: details.summary.revision,
					paths: files.map(change => change.file.path),
				}], CancellationToken.None, details.draftMessage ?? '');
			},
		};
	}

	public async previewCommit(sessionResource: URI, token: CancellationToken, selection?: ISessionChangesEditorOptions['changesetSelection']): Promise<void> {
		const { sessionId, threadId } = this.getConversation(sessionResource);
		const captures = await this.chat.listTurnChanges(sessionId, threadId);
		if (this.isDisposed || token.isCancellationRequested) return;
		const turnNumbers = new Map(getCapturedTurnIds(captures).map((id, index) => [id, index + 1]));
		const selectedId = selection?.kind === 'transient' ? selection.changeset.id : selection?.kind === 'id' ? selection.id : undefined;
		const items = (await Promise.all(captures.map(async capture => {
			if (capture.captureState !== 'sealed' || !capture.statistics.files || capture.commitState === 'queued' || capture.commitState === 'committing') return [];
			if ((selectedId && capture.changeSetId !== selectedId) || (selection?.kind === 'turn' && capture.turnId !== selection.turnId)) return [];
			const { files, summary } = await this.chat.readTurnChange(sessionId, threadId, capture.changeSetId);
			if (summary.revision !== capture.revision) return [];
			return files.filter(file => !summary.committedPaths.includes(file.path)).map(file => ({
				label: file.path, description: localize('sessions.changes.turn', 'Turn {0}', turnNumbers.get(capture.turnId)!), summary,
			}));
		}))).flat();
		if (this.isDisposed || token.isCancellationRequested) return;
		if (!items.length) throw new Error(localize('sessions.changes.noSelection', 'Select sealed file changes that have not been committed.'));
		using resources = new DisposableStore();
		const picker = resources.add(this.quickInput.createQuickPick<(typeof items)[number]>());
		picker.items = items;
		picker.canSelectMany = true;
		picker.ariaLabel = picker.placeholder = localize('sessions.changes.choosePreviewFiles', 'Choose files for the commit');
		const selected = await new Promise<readonly (typeof items)[number][]>(resolve => {
			resources.add(token.onCancellationRequested(() => picker.hide()));
			resources.add(picker.onDidHide(() => resolve([])));
			resources.add(picker.onDidAccept(() => {
				const files = picker.selectedItems;
				if (!files.length) return;
				if (files.some(file => file.summary.repositoryId !== files[0]!.summary.repositoryId)) {
					picker.description = localize('sessions.changes.previewOneRepository', 'Choose files from one repository at a time.');
					return;
				}
				resolve(files);
				picker.hide();
			}));
			picker.show();
		});
		await this.openCommitPreview(sessionId, threadId, this.groupCommitFiles(selected.map(file => ({ summary: file.summary, path: file.label }))), token);
	}

	public async previewSelectedFiles(sessionResource: URI, token: CancellationToken, files: readonly ISessionFileChange[]): Promise<void> {
		const { sessionId, threadId } = this.getConversation(sessionResource);
		await this.openCommitPreview(sessionId, threadId, this.groupCommitFiles(files.map(({ summary, file }) => ({ summary, path: file.path }))), token);
	}

	private groupCommitFiles(files: readonly { readonly summary: ISessionFileChange['summary']; readonly path: string; }[]): TurnCommitSelection[] {
		const grouped = new Map<string, TurnCommitSelection>();
		for (const { summary: { changeSetId, revision }, path } of files) {
			const existing = grouped.get(changeSetId);
			grouped.set(changeSetId, { changeSetId, expectedRevision: revision, paths: [...(existing?.paths ?? []), path] });
		}
		return [...grouped.values()];
	}

	private async openCommitPreview(sessionId: string, threadId: string, selections: readonly TurnCommitSelection[], token: CancellationToken, draftMessage?: string): Promise<void> {
		const isCurrent = () => !this.isDisposed && !token.isCancellationRequested;
		if (!selections.length || !isCurrent()) return;
		const message = await this.quickInput.input({
			title: localize('sessions.changes.commitMessage', 'Commit message'), value: draftMessage,
			validateInput: async value => value.trim() ? undefined : localize('sessions.changes.messageRequired', 'Enter a commit message.'),
		}, token);
		if (message === undefined || !isCurrent()) return;
		const preview = await this.chat.prepareTurnCommit(sessionId, threadId, selections, message);
		if (!isCurrent()) return;
		const input = await createTurnCommitPreviewInput(this.chat, sessionId, threadId, preview);
		if (isCurrent()) await this.editors.openEditor(input, { pinned: true });
	}

	public setChangesCount(editorResource: URI, count: number | undefined): void {
		const key = editorResource.toString();
		if (this.counts.get(key) === count) { return; }
		this.counts.delete(key);
		if (count !== undefined) { this.counts.set(key, count); }
		const affected = [editorResource];
		if (this.counts.size > 64) {
			const oldest = this.counts.keys().next().value!;
			this.counts.delete(oldest);
			affected.push(URI.parse(oldest));
		}
		this.decorationsChanged.fire(affected);
	}

	private getConversation(resource: URI): { readonly sessionId: string; readonly threadId: string; } {
		const sessionId = resource.path.slice(1);
		const threadId = new URLSearchParams(resource.query).get('thread');
		const session = this.sessions.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!threadId || !session?.chats.some(chat => chat.threadId === threadId)) {
			throw new Error(localize('sessions.changes.sourceUnavailable', 'The Turn source Session is no longer available.'));
		}
		return { sessionId, threadId };
	}
}
