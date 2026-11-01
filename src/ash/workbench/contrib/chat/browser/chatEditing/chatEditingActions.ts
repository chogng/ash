import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID } from '../../common/chat.js';
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
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService, ChatHistoryConflictError, type ChatCheckpoint } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';

export function registerChatEditingActions(): void {
	registerAction2(class RestoreCheckpointAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.restoreCheckpoint', title: localize2('chat.restoreCheckpoint.label', 'Chat: Restore Checkpoint'), f1: true });
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const navigation = accessor.get(IChatSessionNavigationService);
			const source = navigation.getActiveConversation();
			if (!source) { return; }
			const viewingSource = (): boolean => {
				const current = navigation.getActiveConversation();
				return current?.sessionId === source.sessionId && current.threadId === source.threadId;
			};
			const chat = accessor.get(IChatService);
			const checkpoints = await chat.readCheckpoints(source.sessionId, source.threadId);
			if (!viewingSource()) { return; }
			const available = checkpoints.filter(checkpoint => checkpoint.files !== 'unavailable');
			if (available.length === 0) {
				accessor.get(INotificationService).info(localize('chat.restoreCheckpoint.empty', 'No restorable checkpoints are available. {0}', checkpoints.map(checkpoint => checkpoint.unavailableReason).filter(Boolean).join('\n')));
				return;
			}
			const store = new DisposableStore();
			type CheckpointItem = IQuickPickItem & { checkpoint: ChatCheckpoint; boundary: 'before' | 'after'; };
			const picker = store.add(accessor.get(IQuickInputService).createQuickPick<CheckpointItem>());
			picker.ariaLabel = picker.placeholder = localize('chat.restoreCheckpoint.choose', 'Choose a checkpoint to restore into a new chat');
			picker.sortByLabel = false;
			picker.items = available.flatMap((checkpoint, index) => (['before', 'after'] as const).map(boundary => ({
				checkpoint, boundary,
				label: boundary === 'before' ? localize('chat.restoreCheckpoint.before', 'Before checkpoint {0}', index + 1) : localize('chat.restoreCheckpoint.after', 'After checkpoint {0}', index + 1),
				description: checkpoint.turnId,
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

	for (const direction of ['undo', 'redo'] as const) {
		registerAction2(class MoveChatHistoryAction extends Action2 {
			constructor() {
				super({
					id: direction === 'undo' ? 'workbench.action.chat.undoEdit' : 'workbench.action.chat.redoEdit',
					title: direction === 'undo' ? localize2('chatEditing.history.undo', 'Chat: Undo Last Request') : localize2('chatEditing.history.redo', 'Chat: Redo Last Request'),
					f1: true,
				});
			}

			public override async run(accessor: ServicesAccessor): Promise<void> {
				const navigation = accessor.get(IChatSessionNavigationService);
				const source = navigation.getActiveConversation();
				if (!source) { return; }
				const chat = accessor.get(IChatService);
				const notifications = accessor.get(INotificationService);
				try {
					const [history, read] = await Promise.all([chat.readHistoryState(source.sessionId, source.threadId), chat.readThread(source.sessionId, source.threadId)]);
					const current = navigation.getActiveConversation();
					if (current?.sessionId !== source.sessionId || current.threadId !== source.threadId) { return; }
					if (!(direction === 'undo' ? history.canUndo : history.canRedo)) {
						notifications.info(localize('chatEditing.history.unavailable', 'No request is available for this history action. Wait for the current request to finish.'));
						return;
					}
					const directory = read.directory;
					const root = directory ? (directory.type === 'local' ? URI.file(directory.root) : directory.type === 'ssh' ? createSshRemoteWorkspaceUri(directory.host, directory.root) : directory.type === 'remote' ? withRemoteWorkspacePath(URI.from({ scheme: 'ash-remote', authority: directory.authority }), directory.root) : createProviderRemoteWorkspaceUri(directory.providerId, directory.workspace, directory.root, directory.hostAuthority)) : undefined;
					if (root && accessor.get(IWorkingCopyService).getAll().some(copy => copy.isDirty && extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, root))) {
						notifications.info(localize('chatEditing.history.dirty', 'Save or revert unsaved files in this chat directory before changing its history.'));
						return;
					}
					await chat.moveHistory({ ...source, expectedSequence: history.sequence, direction });
				} catch (error) {
					if (error instanceof ChatHistoryConflictError) {
						notifications.error(localize('chatEditing.history.conflict', 'Files changed after the recorded checkpoint. Their changes were kept. Review them before changing this chat history.'));
						return;
					}
					throw error;
				}
				status(direction === 'undo' ? localize('chatEditing.history.undone', 'The last request and its file changes were undone.') : localize('chatEditing.history.redone', 'The request and its file changes were restored.'));
			}
		});
	}


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
export async function createThreadMultiDiffEditorInput(chat: IChatService, sessionId: string, threadId: string, expectedRevision?: string): Promise<MultiDiffEditorInput> {
	const summary = await chat.readThreadChanges(sessionId, threadId);
	const changed = () => new Error(localize('chat.changes.checkpointChanged', 'The conversation changed while loading. Open Changes again to review its current checkpoint.'));
	if (expectedRevision !== undefined && summary.revision !== expectedRevision) throw new ThreadChangesNotCurrentError();
	const items: MultiDiffEditorInputItem[] = [];
	for (const repository of summary.repositories) {
		for (const file of repository.files) {
			const contents = await chat.readThreadChangeFile(sessionId, threadId, summary.revision, repository.repositoryId, file.path);
			if (contents.truncated && !contents.binary) throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.'));
			const resource = URI.from({ scheme: 'ash-thread-change', path: `/${threadId}/${repository.repositoryId}/${file.path}`, query: summary.revision });
			let label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
			if (summary.repositories.length > 1) label = `${repository.repositoryId}: ${label}`;
			if (file.beforeMode && file.afterMode && file.beforeMode !== file.afterMode) {
				label = localize('sessions.changes.modeLabel', '{0} (mode {1} → {2})', label, file.beforeMode, file.afterMode);
			}
			items.push({
				label, binary: contents.binary,
				original: { resource: resource.with({ fragment: 'before' }), initialText: contents.before ?? '', readOnly: true },
				modified: { resource: resource.with({ fragment: 'after' }), initialText: contents.after ?? '', readOnly: true },
			});
		}
	}
	// A history move between the final file read and publication must not publish a stale review.
	if ((await chat.readThreadChanges(sessionId, threadId)).revision !== summary.revision) throw changed();
	const label = localize('chat.changes.conversationTitle', 'Conversation Changes');
	return createMultiDiffEditorInput(
		URI.from({ scheme: 'ash-multi-diff', path: `/conversation/${sessionId}/${threadId}`, query: summary.revision }),
		items, summary.warnings.length ? localize('sessions.changes.previewWarnings', '{0} — Review: {1}', label, summary.warnings.join('; ')) : label,
		{ kind: 'snapshot', label },
	);
}

export function registerChatChangesActions(): void {
	CommandsRegistry.register(OPEN_CHAT_CHANGES_COMMAND_ID, async (accessor, sessionId, threadId, revision) => {
		if (sessionId === undefined && threadId === undefined) {
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
		using selection = sessions.captureSelection();
		const chat = accessor.get(IChatService);
		const input = await createThreadMultiDiffEditorInput(chat, sessionId, threadId, revision).catch(error => {
			if (!(error instanceof ThreadChangesNotCurrentError)) throw error;
			if (!selection.isCurrent()) return undefined;
			// Capture notifications can update the counts before the final journal revision arrives.
			// Start once from the current checkpoint; changes during file loading still reject review.
			return createThreadMultiDiffEditorInput(chat, sessionId, threadId);
		});
		if (!input || !selection.isCurrent()) return;
		await accessor.get(IEditorService).openEditor(input, { pinned: true });
	});
}
