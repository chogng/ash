import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IChatEditingService, type IModifiedFileEntry } from '../../common/editing/chatEditingService.js';

registerAction2(class ReviewChangesAction extends Action2 {
	constructor() { super({ id: 'chatEditing.reviewChanges', title: localize2('chatEditing.review', 'Review Agent changes'), f1: true }); }
	public override run(accessor: ServicesAccessor): void {
		const editing = accessor.get(IChatEditingService);
		const notifications = accessor.get(INotificationService);
		const codeEditors = accessor.get(ICodeEditorService);
		const store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem & { entry: IModifiedFileEntry; }>());
		picker.ariaLabel = picker.placeholder = localize('chatEditing.review', 'Review Agent changes');
		const countdowns = new Map<IModifiedFileEntry, boolean>();
		const refresh = (): void => {
			countdowns.clear();
			picker.items = editing.entries.map(entry => {
				const seconds = editing.getAutoAcceptCountdown(entry);
				countdowns.set(entry, seconds !== undefined);
				return { entry, label: entry.resources.map(basename).join(', '), description: entry.isFileOperation ? localize('chatEditing.atomic', 'Atomic file operation') : localize('chatEditing.changeCount', '{0} changes', entry.hunks.length), detail: seconds === undefined ? entry.getAccessibleContent() : localize('chatEditing.autoAcceptPending', 'Automatic acceptance pending. {0}', entry.getAccessibleContent()), buttons: [{ id: 'accept', label: entry.isFileOperation ? localize('chatEditing.acceptSet', 'Accept change set') : localize('chatEditing.accept', 'Accept file changes') }, { id: 'reject', label: entry.isFileOperation ? localize('chatEditing.rejectSet', 'Reject change set') : localize('chatEditing.reject', 'Reject file changes') }, ...(seconds === undefined ? [] : [{ id: 'cancelAutoAccept', label: localize('chatEditing.cancelAutoAccept', 'Cancel automatic acceptance') }])] };
			});
		};
		store.add(editing.onDidChange(refresh));
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
			void (button.id === 'accept' ? editing.acceptEntry(item.entry) : editing.rejectEntry(item.entry)).then(() => status(localize('chatEditing.reviewed', 'Changes reviewed.')), error => notifications.error(localize('chatEditing.failed', 'Could not review changes: {0}', String(error))));
		}));
		store.add(picker.onDidAccept(item => { picker.hide(); void codeEditors.openCodeEditor({ resource: item.entry.modifiedURI }, null); }));
		store.add(picker.onDidHide(() => store.dispose()));
		refresh();
		picker.show();
	}
});

for (const accept of [true, false]) {
	registerAction2(class ReviewAllAction extends Action2 {
		constructor() { super({ id: accept ? 'chatEditing.acceptAll' : 'chatEditing.rejectAll', title: accept ? localize2('chatEditing.acceptAll', 'Accept all Agent changes') : localize2('chatEditing.rejectAll', 'Reject all Agent changes'), f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const editing = accessor.get(IChatEditingService);
			if (accept) { await editing.accept(); } else { await editing.reject(); }
			status(localize('chatEditing.reviewed', 'Changes reviewed.'));
		}
	});
}
