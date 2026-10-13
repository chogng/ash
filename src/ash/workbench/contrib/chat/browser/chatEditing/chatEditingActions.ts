import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService, ChatHistoryConflictError, type ChatCheckpoint } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';

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
		if (!selected) { return; }
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
				const root = directory ? (directory.type === 'local' ? URI.file(directory.root) : createSshRemoteWorkspaceUri(directory.host, directory.root)) : undefined;
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
