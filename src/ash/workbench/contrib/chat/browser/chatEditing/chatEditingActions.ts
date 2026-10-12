import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService, type ChatCheckpoint } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

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
			store.add(picker.onDidAccept(item => { resolve(item); picker.hide(); }));
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
