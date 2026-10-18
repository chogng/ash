import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import type { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IQuickAccessController } from '../../../../../../platform/quickinput/common/quickAccess.js';
import type { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import type { IChatContextPickService } from '../../../../../services/chat/common/chatContextService.js';
import type { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import type { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { NotificationService } from '../../../../../services/notification/common/notificationService.js';
import { AttachContextAction } from '../../../browser/actions/chatContextActions.js';

for (const cancellation of ['Escape', 'toggle', 'dispose'] as const) {
	test(`Attachment search ${cancellation} restores only a surviving composer after shared picker focus restoration`, async () => {
		using resources = new DisposableStore();
		const container = document.createElement('div');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const anchor = document.createElement('button');
		const input = document.createElement('textarea');
		container.append(anchor, input);
		setARIAContainer(container);
		const quickInput = resources.add(new TestQuickInputService({ container }));
		const notifications = resources.add(new NotificationService());
		const shown = new DeferredPromise<void>();
		const quickAccess: IQuickAccessController = {
			onDidChangeVisibility: Event.None,
			show: (_value, options) => {
				const picker = resources.add(quickInput.createQuickPick());
				picker.anchor = options?.anchor;
				picker.show();
				void shown.complete();
			},
		};
		Object.defineProperty(quickInput, 'quickAccess', { value: quickAccess });
		// Catalog sources are unrelated to this ownership contract; the shared picker
		// itself remains real so its normal anchor focus restoration precedes the owner.
		const instantiation = {
			createChild: () => Object.assign(new DisposableStore(), { createInstance: () => ({ isEnabled: () => false }) }),
			createInstance: () => ({}),
		} as unknown as IInstantiationService;
		let focused = 0;
		let acquired = 0;
		const action = resources.add(new AttachContextAction({
			container,
			target: {
				attachFiles: async () => { acquired++; },
				acquireContext: async () => { acquired++; return []; },
			},
			focusInput: () => { focused++; input.focus(); },
			supportsImages: () => false,
		}, quickInput, { items: [] } as unknown as IChatContextPickService, instantiation,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
			{ groups: [] } as unknown as IEditorGroupsService,
			{ getActiveConversation: () => undefined } as unknown as IChatSessionNavigationService, notifications));
		anchor.focus();
		const running = action.run(anchor);
		await Promise.race([shown.p, running.then(() => { throw new Error(`Picker did not open: ${notifications.model.getNotifications().map(item => item.message).join('; ')}`); })]);
		assert.notEqual(document.activeElement, anchor);
		if (cancellation === 'Escape') {
			document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		} else if (cancellation === 'toggle') {
			await action.run(anchor);
		} else {
			action.dispose();
		}
		await running;
		assert.deepEqual({ focused, acquired, notifications: notifications.model.getNotifications(), expanded: anchor.getAttribute('aria-expanded') }, {
			focused: cancellation === 'dispose' ? 0 : 1,
			acquired: 0,
			notifications: [],
			expanded: 'false',
		});
		assert.equal(document.activeElement, cancellation === 'dispose' ? anchor : input);
		assert.equal(quickInput.currentQuickInput, undefined);
	});
}
