import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, type IReader } from '../../../../../base/common/observable.js';
import { basename } from '../../../../../base/common/resources.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IChatEditingService, type IChatEditReviewSession, type IModifiedFileEntry } from '../../common/editing/chatEditingService.js';

async function selectReviewSession(accessor: ServicesAccessor): Promise<IChatEditReviewSession | undefined> {
	const editing = accessor.get(IChatEditingService);
	const sessions = editing.editingSessionsObs.get();
	if (sessions.length <= 1) { return sessions[0]; }
	const store = new DisposableStore();
	const picker = store.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem & { session: IChatEditReviewSession; }>());
	picker.ariaLabel = picker.placeholder = localize('chatEditing.selectChat', 'Choose a chat to review its Agent changes');
	const refresh = (): void => {
		picker.items = editing.editingSessionsObs.get().map(session => ({
			session,
			label: localize('chatEditing.chat', 'Chat {0}', new URLSearchParams(session.chatSessionResource.query).get('threadId')),
			description: localize('chatEditing.fileSet', '{0} files', new Set(session.entries.get().flatMap(entry => entry.resources.map(resource => resource.toString()))).size),
			detail: session.entries.get().map(entry => entry.resources.map(basename).join(', ')).join('; '),
		}));
	};
	store.add(editing.onDidChange(refresh));
	return new Promise(resolve => {
		store.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			resolve(item.session); picker.hide();
		}));
		store.add(picker.onDidHide(() => { resolve(undefined); store.dispose(); }));
		refresh();
		picker.show();
	});
}

registerAction2(class ReviewChangesAction extends Action2 {
	constructor() { super({ id: 'chatEditing.reviewChanges', title: localize2('chatEditing.review', 'Review Agent changes'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editing = accessor.get(IChatEditingService);
		const session = await selectReviewSession(accessor);
		if (!session) { return; }
		const notifications = accessor.get(INotificationService);
		const codeEditors = accessor.get(ICodeEditorService);
		const store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem & { entry: IModifiedFileEntry; }>());
		picker.ariaLabel = picker.placeholder = localize('chatEditing.review', 'Review Agent changes');
		const countdowns = new Map<IModifiedFileEntry, boolean>();
		const refresh = (reader?: IReader): void => {
			countdowns.clear();
			picker.items = session.entries.read(reader).map(entry => {
				const seconds = editing.getAutoAcceptCountdown(entry);
				const chats = editing.editingSessionsObs.read(reader).filter(candidate =>
					(reader ? candidate.readEntry(entry.modifiedURI, reader) : candidate.getEntry(entry.modifiedURI)) === entry,
				).length;
				const content = chats > 1 ? localize('chatEditing.sharedContent', 'Shared changes from {0} chats. Reviewing this file or change set affects all contributing chats.\n{1}', chats, entry.getAccessibleContent()) : entry.getAccessibleContent();
				countdowns.set(entry, seconds !== undefined);
				return {
					entry,
					label: entry.resources.map(basename).join(', '),
					description: entry.hasPendingSave ? localize('chatEditing.retrySave', 'Retry saving reviewed changes') : entry.isFileOperation ? localize('chatEditing.atomic', 'Atomic file operation') : localize('chatEditing.changeCount', '{0} changes', entry.hunks.length),
					detail: seconds === undefined ? content : localize('chatEditing.autoAcceptPending', 'Automatic acceptance pending. {0}', content),
					buttons: [
						{ id: 'accept', label: chats > 1 ? localize('chatEditing.acceptShared', 'Accept changes from {0} chats', chats) : entry.isFileOperation ? localize('chatEditing.acceptSet', 'Accept change set') : localize('chatEditing.accept', 'Accept file changes') },
						{ id: 'reject', label: entry.hasPendingSave ? localize('chatEditing.retrySave', 'Retry saving reviewed changes') : chats > 1 ? localize('chatEditing.rejectShared', 'Reject changes from {0} chats', chats) : entry.isFileOperation ? localize('chatEditing.rejectSet', 'Reject change set') : localize('chatEditing.reject', 'Reject file changes') },
						...(seconds === undefined ? [] : [{ id: 'cancelAutoAccept', label: localize('chatEditing.cancelAutoAccept', 'Cancel automatic acceptance') }]),
					],
				};
			});
		};
		store.add(autorun(reader => refresh(reader)));
		store.add(editing.onDidChangeAutoAccept(entry => {
			// The list changes only when cancellation becomes available, so ticks preserve keyboard focus.
			if (countdowns.get(entry) !== (editing.getAutoAcceptCountdown(entry) !== undefined)) { refresh(); }
		}));
		store.add(picker.onDidTriggerItemButton(({ item, button }) => {
			if (button.id === 'cancelAutoAccept') {
				editing.cancelAutoAccept(item.entry);
				status(localize('chatEditing.autoAcceptCancelled', 'Automatic acceptance cancelled. Changes remain available for review.'));
				return;
			}
			void (button.id === 'accept' ? editing.acceptEntry(item.entry) : item.entry.hasPendingSave ? editing.retrySaveEntry(item.entry) : editing.rejectEntry(item.entry)).then(() => status(localize('chatEditing.reviewed', 'Changes reviewed.')), error => notifications.error(localize('chatEditing.failed', 'Could not review changes: {0}', String(error))));
		}));
		store.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			picker.hide(); void codeEditors.openCodeEditor({ resource: item.entry.modifiedURI }, null);
		}));
		store.add(session.onDidDispose(() => picker.hide()));
		store.add(picker.onDidHide(() => store.dispose()));
		picker.show();
	}
});

for (const accept of [true, false]) {
	registerAction2(class ReviewAllAction extends Action2 {
		constructor() { super({ id: accept ? 'chatEditing.acceptAll' : 'chatEditing.rejectAll', title: accept ? localize2('chatEditing.acceptAll', 'Accept all Agent changes in a chat') : localize2('chatEditing.rejectAll', 'Reject all Agent changes in a chat'), f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const session = await selectReviewSession(accessor);
			if (!session) { return; }
			if (accept) { await session.accept(); } else { await session.reject(); }
			status(localize('chatEditing.reviewed', 'Changes reviewed.'));
		}
	});
}
