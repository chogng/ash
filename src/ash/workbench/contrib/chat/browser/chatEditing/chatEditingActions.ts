import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID, type ChatChangedFileTarget } from '../../common/chat.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { VIEW_PANE_ID } from '../../../scm/common/scm.js';
import { IAgentSessionActionsService } from '../agentSessions/agentSessionsService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { createSshRemoteWorkspaceUri, createProviderRemoteWorkspaceUri, withRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService, ChatHistoryConflictError, createThreadChangeFileResource, type ChatCheckpoint } from '../../../../services/chat/common/chatService.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../../base/common/cancellation.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatRequestActionContext, IChatWidgetService, type ChatRequestVersion } from '../chat.js';
import { isRecord } from '../../../../../base/common/types.js';

export const RestoreCheckpointActionId = 'workbench.action.chat.restoreCheckpoint';
export const RedoChatHistoryActionId = 'workbench.action.chat.redoEdit';
export const EditChatRequestActionId = 'workbench.action.chat.editRequests';
const canEditRequest = ContextKeyExpr.and(ChatContextKeys.requestCanEdit.isEqualTo(true), ChatContextKeys.transcriptProgressActive.isEqualTo(false));

export function registerChatEditRequestAction(): void {
	registerAction2(class EditAction extends Action2 {
		constructor() {
			super({
				id: EditChatRequestActionId,
				title: localize2('chat.edit.label', 'Edit message'),
				icon: Lxicon.edit,
				menu: { id: MenuId.ChatMessageTitle, group: 'navigation', order: 2, when: canEditRequest },
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (context instanceof ChatRequestActionContext && context.visible && (context.item.requestSource || context.item.requestEdit)) {
				await context.startEditing(context.item.id);
			} else if (context === undefined) {
				const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
				const item = widget?.getFocus();
				if (item && (item.requestSource || item.requestEdit)) await widget?.startEditing(item.id);
			}
		}
	});
	registerAction2(class SelectRequestVersionAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.selectRequestVersion',
				title: localize2('chat.edit.versions', 'Message versions'),
				icon: Lxicon.history,
				menu: {
					id: MenuId.ChatMessageTitle, group: 'navigation', order: 3,
					when: ContextKeyExpr.and(ChatContextKeys.transcriptProgressActive.isEqualTo(false), ChatContextKeys.requestHasVersions.isEqualTo(true)),
				},
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (!(context instanceof ChatRequestActionContext) || !context.visible || !context.getVersions) return;
			const quickInput = accessor.get(IQuickInputService);
			const versions = await context.getVersions(context.item);
			if (!context.visible || versions.length < 2) return;
			using store = new DisposableStore();
			const picker = store.add(quickInput.createQuickPick<IQuickPickItem & { version: ChatRequestVersion; }>());
			picker.ariaLabel = picker.placeholder = localize('chat.edit.chooseVersion', 'Choose a message version');
			picker.sortByLabel = false;
			const items = versions.map(version => ({
				label: version.text.trim().replace(/\s+/gu, ' ').slice(0, 160),
				description: version.selected ? localize('chat.edit.currentVersion', 'Current version') : undefined,
				version,
			}));
			picker.items = items;
			picker.activeItems = items.filter(item => item.version.selected);
			const selected = await new Promise<ChatRequestVersion | undefined>(resolve => {
				store.add(picker.onDidAccept(() => {
					resolve(picker.selectedItems[0]?.version);
					picker.hide();
				}));
				store.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			if (context.visible && selected && !selected.selected) await selected.select();
		}
	});
}

export function registerChatRestoreCheckpointAction(): void {
	registerAction2(class RestoreCheckpointAction extends Action2 {
		constructor() {
			super({ id: RestoreCheckpointActionId, title: localize2('chat.restoreCheckpoint.label', 'Chat: Restore Checkpoint'), precondition: ChatContextKeys.enabled.isEqualTo(true), f1: true });
		}

		public override async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
			const navigation = accessor.get(IChatSessionNavigationService);
			const source = navigation.getActiveConversation();
			if (!source) { return; }
			let itemId: string | undefined;
			if (target !== undefined) {
				if (!target || typeof target !== 'object' || !('sessionId' in target) || target.sessionId !== source.sessionId
					|| !('threadId' in target) || target.threadId !== source.threadId || !('itemId' in target)
					|| typeof target.itemId !== 'string' || !target.itemId) return;
				itemId = target.itemId;
			}
			const revision = navigation.revision;
			const viewingSource = (): boolean => {
				const current = navigation.getActiveConversation();
				return navigation.revision === revision && current?.sessionId === source.sessionId && current.threadId === source.threadId;
			};
			const chat = accessor.get(IChatService);
			const notifications = accessor.get(INotificationService);
			const quickInput = accessor.get(IQuickInputService);
			const checkpoints = (await chat.readCheckpoints(source.sessionId, source.threadId))
				.filter(checkpoint => itemId === undefined || checkpoint.itemId === itemId);
			if (!viewingSource()) { return; }
			const available = checkpoints.filter(checkpoint => checkpoint.files !== 'unavailable');
			if (available.length === 0) {
				notifications.info(localize('chat.restoreCheckpoint.empty', 'No restorable checkpoints are available. {0}', checkpoints.map(checkpoint => checkpoint.unavailableReason).filter(Boolean).join('\n')));
				return;
			}
			const store = new DisposableStore();
			type CheckpointItem = IQuickPickItem & { checkpoint: ChatCheckpoint; boundary: 'before' | 'after'; };
			const picker = store.add(quickInput.createQuickPick<CheckpointItem>());
			picker.ariaLabel = picker.placeholder = localize('chat.restoreCheckpoint.choose', 'Choose a checkpoint to restore into a new chat');
			picker.sortByLabel = false;
			const messageLabels = itemId === undefined ? undefined : {
				before: localize('chat.restoreCheckpoint.beforeMessage', 'Before this message'),
				after: localize('chat.restoreCheckpoint.afterMessage', 'After this message'),
			};
			picker.items = available.flatMap((checkpoint, index) => (['before', 'after'] as const).map(boundary => ({
				checkpoint, boundary,
				label: messageLabels?.[boundary] ?? (boundary === 'before'
					? localize('chat.restoreCheckpoint.before', 'Before checkpoint {0}', index + 1)
					: localize('chat.restoreCheckpoint.after', 'After checkpoint {0}', index + 1)),
				description: itemId === undefined ? checkpoint.turnId : undefined,
				detail: checkpoint.files !== 'noFiles'
					? localize('chat.restoreCheckpoint.files', 'Creates a new chat and restores checkpoint files in a new directory. The original chat and directory are kept.')
					: localize('chat.restoreCheckpoint.noFiles', 'Creates a new chat at this message boundary. This checkpoint contains no files.'),
			}))).reverse();
			const selected = await new Promise<CheckpointItem | undefined>(resolve => {
				store.add(picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;
					resolve(item); picker.hide();
				}));
				store.add(picker.onDidHide(() => { resolve(undefined); store.dispose(); }));
				picker.show();
			});
			if (!selected || !viewingSource()) { return; }
			const restored = await chat.restoreCheckpoint({
				...source, itemId: selected.checkpoint.itemId, boundary: selected.boundary,
				title: localize('chat.restoreCheckpoint.title', 'Restored checkpoint: {0}', selected.checkpoint.itemId),
			});
			if (viewingSource()) {
				await navigation.openConversation(restored.sessionId, restored.threadId);
			}
			status(localize('chat.restoreCheckpoint.done', 'Checkpoint restored in a new chat.'));
		}
	});
}

export function registerChatHistoryActions(): void {
	for (const direction of ['undo', 'redo'] as const) {
		registerAction2(class MoveChatHistoryAction extends Action2 {
			constructor() {
				super({
					id: direction === 'undo' ? 'workbench.action.chat.undoEdit' : RedoChatHistoryActionId,
					title: direction === 'undo' ? localize2('chatEditing.history.undo', 'Chat: Undo Last Request') : localize2('chatEditing.history.redo', 'Chat: Redo Last Request'),
					f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
				});
			}

			public override async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
				const navigation = accessor.get(IChatSessionNavigationService);
				const source = navigation.getActiveConversation();
				if (!source) { return; }
				let expectedSequence: number | undefined;
				if (target !== undefined) {
					if (direction !== 'redo' || !target || typeof target !== 'object' || !('sessionId' in target) || target.sessionId !== source.sessionId
						|| !('threadId' in target) || target.threadId !== source.threadId || !('expectedSequence' in target)
						|| typeof target.expectedSequence !== 'number' || !Number.isSafeInteger(target.expectedSequence) || target.expectedSequence < 0) return;
					expectedSequence = target.expectedSequence;
				}
				const revision = navigation.revision;
				const viewingSource = (): boolean => {
					const current = navigation.getActiveConversation();
					return navigation.revision === revision && current?.sessionId === source.sessionId && current.threadId === source.threadId;
				};
				const chat = accessor.get(IChatService);
				const notifications = accessor.get(INotificationService);
				const workingCopies = accessor.get(IWorkingCopyService);
				try {
					const [history, read] = await Promise.all([chat.readHistoryState(source.sessionId, source.threadId), chat.readThread(source.sessionId, source.threadId)]);
					if (!viewingSource()) { return; }
					if (expectedSequence !== undefined && history.sequence !== expectedSequence) throw new ChatHistoryConflictError();
					if (!(direction === 'undo' ? history.canUndo : history.canRedo)) {
						notifications.info(localize('chatEditing.history.unavailable', 'No request is available for this history action. Wait for the current request to finish.'));
						return;
					}
					const directory = read.directory;
					const root = directory ? (directory.type === 'local' ? URI.file(directory.root) : directory.type === 'ssh' ? createSshRemoteWorkspaceUri(directory.host, directory.root) : directory.type === 'remote' ? withRemoteWorkspacePath(URI.from({ scheme: 'ash-remote', authority: directory.authority }), directory.root) : createProviderRemoteWorkspaceUri(directory.providerId, directory.workspace, directory.root, directory.hostAuthority)) : undefined;
					if (root && workingCopies.getAll().some(copy => copy.isDirty && extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, root))) {
						notifications.info(localize('chatEditing.history.dirty', 'Save or revert unsaved files in this chat directory before changing its history.'));
						return;
					}
					await chat.moveHistory({ ...source, expectedSequence: history.sequence, direction });
				} catch (error) {
					if (!viewingSource()) { return; }
					if (error instanceof ChatHistoryConflictError) {
						notifications.error(localize('chatEditing.history.conflict', 'Files changed after the recorded checkpoint. Their changes were kept. Review them before changing this chat history.'));
						return;
					}
					throw error;
				}
				if (!viewingSource()) { return; }
				status(direction === 'undo' ? localize('chatEditing.history.undone', 'The last request and its file changes were undone.') : localize('chatEditing.history.redone', 'The request and its file changes were restored.'));
			}
		});
	}
}


export function registerChatEditingActions(): void {
	registerAction2(class RenameChatAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.rename', title: localize2('chat.rename.label', 'Chat: Rename Conversation'), f1: true });
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const source = accessor.get(IChatSessionNavigationService).getActiveConversation();
			if (!source) return;
			const chat = accessor.get(IChatService);
			const current = await chat.readThread(source.sessionId, source.threadId, { type: 'latest', turnLimit: 1 });
			const title = await accessor.get(IQuickInputService).input({
				title: localize('chat.rename.prompt', 'Conversation name'), value: current.thread.title,
				validateInput: async value => !value.trim() || Array.from(value.trim()).length > 256 ? localize('chat.rename.invalid', 'Enter a name with 1 to 256 characters.') : undefined,
			});
			if (title === undefined) return;
			await chat.renameThread(source.sessionId, source.threadId, title.trim());
			status(localize('chat.rename.done', 'Conversation renamed.'));
		}
	});
}

/** The composer can lag behind the current checkpoint before review starts. */
class ThreadChangesNotCurrentError extends Error {
	constructor() {
		super(localize('chat.changes.checkpointChanged', 'The conversation changed while loading. Open Changes again to review its current checkpoint.'));
	}
}

/** Opens precisely the checkpoint revision advertised by the composer, across all repositories. */
export async function createThreadMultiDiffEditorInput(chat: IChatService, sessionId: string, threadId: string, expectedRevision?: string, signal?: AbortSignal): Promise<MultiDiffEditorInput> {
	return (await readThreadChangesComparison(chat, sessionId, threadId, expectedRevision, signal)).input;
}

/** Returns the comparison and the metadata from the same checkpoint revision. */
export async function readThreadChangesComparison(chat: IChatService, sessionId: string, threadId: string, expectedRevision?: string, signal?: AbortSignal, target?: ChatChangedFileTarget) {
	const read = <T>(promise: Promise<T>): Promise<T> => signal ? raceCancellationError(promise, signal) : promise;
	if (signal) { throwIfCancelled(signal); }
	const summary = await read(chat.readThreadChanges(sessionId, threadId));
	if (expectedRevision !== undefined && summary.revision !== expectedRevision) throw new ThreadChangesNotCurrentError();
	const items: MultiDiffEditorInputItem[] = [];
	let selectedResource: URI | undefined;
	for (const [index, repository] of summary.repositories.entries()) {
		if (target && repository.repositoryId !== target.repositoryId) continue;
		for (const file of repository.files) {
			if (target && file.path !== target.path) continue;
			if (signal) { throwIfCancelled(signal); }
			const contents = await read(chat.readThreadChangeFile(sessionId, threadId, summary.revision, repository.repositoryId, file.path));
			if (contents.truncated && !contents.binary) throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.'));
			const resource = createThreadChangeFileResource(sessionId, threadId, summary.revision, repository.repositoryId, file.path);
			if (target) selectedResource = resource.with({ scheme: 'ash-multi-diff', path: `/conversation-file${resource.path}` });
			let label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
			if (summary.repositories.length > 1) label = `${repository.repositoryId}: ${label}`;
			if (file.beforeMode && file.afterMode && file.beforeMode !== file.afterMode) {
				label = localize('sessions.changes.modeLabel', '{0} (mode {1} → {2})', label, file.beforeMode, file.afterMode);
			}
			items.push({
				label, binary: contents.binary,
				fileList: {
					path: file.path,
					originalPath: file.previousPath,
					statistics: contents.binary ? undefined : { additions: file.additions, deletions: file.deletions },
					...(summary.repositories.length > 1 ? {
						group: { id: JSON.stringify([repository.repositoryId]), label: localize('sessions.changes.repository', 'Repository {0}', index + 1) },
					} : {})
				},
				original: { resource: resource.with({ query: `${resource.query}&side=before` }), initialText: contents.before ?? '', readOnly: true },
				modified: { resource: resource.with({ query: `${resource.query}&side=after` }), initialText: contents.after ?? '', readOnly: true },
			});
		}
	}
	if (target && !selectedResource) throw new ThreadChangesNotCurrentError();
	// A history move between the final file read and publication must not publish a stale review.
	if (items.length && (await read(chat.readThreadChanges(sessionId, threadId))).revision !== summary.revision) {
		throw new Error(localize('chat.changes.checkpointChanged', 'The conversation changed while loading. Open Changes again to review its current checkpoint.'));
	}
	const label = target ? items[0].label : localize('chat.changes.conversationTitle', 'Conversation Changes');
	const input = createMultiDiffEditorInput(
		selectedResource ?? URI.from({ scheme: 'ash-multi-diff', path: `/conversation/${sessionId}/${threadId}`, query: summary.revision }),
		items, summary.warnings.length ? localize('sessions.changes.previewWarnings', '{0} — Review: {1}', label, summary.warnings.join('; ')) : label,
		{ kind: 'snapshot', label },
	);
	return { input, summary };
}

export function registerChatChangesActions(): void {
	CommandsRegistry.register(OPEN_CHAT_CHANGES_COMMAND_ID, async (accessor, sessionId, threadId, revision, file: unknown) => {
		if (file === undefined && sessionId === undefined && threadId === undefined) {
			const views = accessor.get(IViewsService);
			await accessor.get(ICommandService).executeCommand('git.openWorkspaceChanges');
			await views.focusView(VIEW_PANE_ID);
			return;
		}
		if (typeof sessionId !== 'string' || !sessionId || typeof threadId !== 'string' || !threadId) {
			throw new Error(localize('chat.changes.invalidIdentity', 'Changes require a conversation.'));
		}
		const sessions = accessor.get(IAgentSessionActionsService);
		const session = sessions.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session || !session.threadIds.includes(threadId)) {
			throw new Error(localize('chat.changes.unavailable', 'This conversation is no longer available.'));
		}
		if (revision !== undefined && typeof revision !== 'string') throw new TypeError('Invalid changes revision');
		let target: ChatChangedFileTarget | undefined;
		if (file !== undefined) {
			if (!revision || !isRecord(file) || typeof file.repositoryId !== 'string' || !file.repositoryId || typeof file.path !== 'string' || !file.path) {
				throw new TypeError('Invalid changed file selection');
			}
			target = { repositoryId: file.repositoryId, path: file.path };
		}
		using selection = sessions.captureSelection();
		const chat = accessor.get(IChatService);
		const input = await readThreadChangesComparison(chat, sessionId, threadId, revision, undefined, target).then(result => result.input).catch(error => {
			if (target || !(error instanceof ThreadChangesNotCurrentError)) throw error;
			if (!selection.isCurrent()) return undefined;
			// Capture notifications can update the counts before the final journal revision arrives.
			// Start once from the current checkpoint; changes during file loading still reject review.
			return createThreadMultiDiffEditorInput(chat, sessionId, threadId);
		});
		if (!input || !selection.isCurrent()) return;
		await accessor.get(IEditorService).openEditor(input, { pinned: true });
	});
}
