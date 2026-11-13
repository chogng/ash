import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import type { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { IBlockedSessionsIndicatorService, IBlockedSession } from './blockedSessionsIndicatorModel.js';
import type { BlockedSessionsCIFixModel } from './blockedSessionsCIFixModel.js';
import { Severity, type INotificationService } from '../../../../platform/notification/common/notification.js';

export function showBlockedSessionsList(
	quickInput: IQuickInputService,
	navigation: IChatSessionNavigationService,
	indicator: IBlockedSessionsIndicatorService,
	fixes: BlockedSessionsCIFixModel | undefined,
	notifications: INotificationService,
	anchor: HTMLElement,
): IDisposable {
	const lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<IQuickPickItem & IBlockedSession>());
	picker.anchor = anchor;
	picker.ariaLabel = localize('sessions.blocked.list', 'Sessions requiring attention');
	picker.placeholder = picker.ariaLabel;
	picker.sortByLabel = false;
	const ignore = { id: 'ignore', label: localize('sessions.blocked.ignore', 'Ignore this alert') };
	const ignoreAll = { label: localize('sessions.blocked.ignoreAll', 'Ignore all current alerts') };
	const fixAll = { label: localize('sessions.blocked.fixAll', 'Ask agents to fix failing checks') };
	const ignoreWithUndo = (items: readonly IBlockedSession[]): void => {
		const undo = indicator.ignore(items);
		if (!undo) return;
		notifications.notify({
			severity: Severity.Info,
			message: items.length === 1
				? localize('sessions.blocked.ignoredOne', 'Ignored 1 session alert.')
				: localize('sessions.blocked.ignoredMany', 'Ignored {0} session alerts.', items.length),
			actions: {
				primary: [{
					id: 'sessions.blocked.undoIgnore',
					label: localize('sessions.blocked.undoIgnore', 'Undo'),
					tooltip: '',
					enabled: true,
					run: async () => undo(),
				}],
			},
		});
	};
	lifetime.add(picker.onDidTriggerItemButton(({ item, button }) => {
		if (button.id === ignore.id) ignoreWithUndo([item]);
	}));
	lifetime.add(picker.onDidTriggerButton(button => {
		const items = indicator.blockedSessions.get();
		if (button === ignoreAll) {
			ignoreWithUndo(items);
		} else if (button === fixAll && fixes) {
			picker.hide();
			void fixes.fixAll(items, item => indicator.blockedSessions.get().some(current =>
				current.session.sessionId === item.session.sessionId && current.threadId === item.threadId && current.occurrence === item.occurrence))
				.catch(error => notifications.error(error));
		}
	}));
	lifetime.add(picker.onDidHide(() => lifetime.dispose()));
	lifetime.add(picker.onDidAccept(() => {
		const item = picker.selectedItems[0];
		if (!item) return;
		const { session, threadId } = item;
		const sideBySide = picker.keyMods?.alt === true;
		picker.hide();
		const opening = sideBySide && navigation.openSideConversation
			? navigation.openSideConversation(session.sessionId, threadId)
			: navigation.openConversation(session.sessionId, threadId);
		void opening.catch(onUnexpectedError);
	}));
	lifetime.add(autorun(reader => {
		const blocked = indicator.blockedSessions.read(reader);
		if (!blocked.length) {
			picker.hide();
			return;
		}
		picker.buttons = fixes && blocked.some(item => item.checks?.some(request => request.headCommit)) ? [ignoreAll, fixAll] : [ignoreAll];
		picker.items = blocked.map(item => ({
			...item,
			label: item.session.title || localize('sessions.list.untitled', 'Untitled Session'),
			description: item.reason === 'input' ? localize('sessions.management.needsInput', 'Needs input') : localize('sessions.blocked.failingChecks', 'Failing checks'),
			detail: item.session.providerLabel,
			buttons: [ignore],
		}));
	}));
	picker.show();
	return lifetime;
}
