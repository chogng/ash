import assert from 'node:assert/strict';
import { test } from 'mocha';
import { SubmenuAction } from '../../../../../../base/common/actions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { type IMenuChangeEvent, type IMenuService, MenuId, MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import type { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import type { INativeMenubarData, INativeMenubarSelection } from '../../../../../../platform/menubar/common/nativeMenubar.js';
import type { IMenubarService } from '../../../../../../platform/menubar/electron-browser/menubar.js';
import { NativeMenubarControl } from '../../../../../../workbench/electron-browser/parts/titlebar/menubarControl.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { CancellationError } from '../../../../../../base/common/errors.js';

test('failed menubar updates retain the last installed revision', async () => {
	const changes = new Emitter<IMenuChangeEvent>();
	const selections = new Emitter<INativeMenubarSelection>();
	const updates: INativeMenubarData[] = [];
	const failures = new Set<number>();
	const runs: string[] = [];
	let commandFailure: Error | undefined;
	const commandService = {
		onWillExecuteCommand: Event.None,
		onDidExecuteCommand: Event.None,
		executeCommand: async (id: string) => {
			if (commandFailure) throw commandFailure;
			runs.push(id);
		},
	} as ICommandService;
	using contextKeys = new ContextKeyService();
	const alternate = new MenuItemAction(
		{ id: 'save-as', title: 'Save As' },
		undefined,
		undefined,
		contextKeys,
		commandService,
	);
	const primary = new MenuItemAction(
		{ id: 'save', title: 'Save' },
		alternate,
		undefined,
		contextKeys,
		commandService,
	);
	const menu = {
		onDidChange: changes.event,
		getActions: () => [['navigation', [new SubmenuAction('file', 'File', [primary])]]] as const,
		dispose() { },
		[Symbol.dispose]() { },
	};
	const menuService = {
		createMenu: (id: MenuId) => id === MenuId.MenubarMainMenu ? menu : { ...menu, onDidChange: Event.None, getActions: () => [] },
		getMenuActions: () => [],
	} as unknown as IMenuService;
	const api: IMenubarService = {
		_serviceBrand: undefined,
		async updateMenubar(data): Promise<void> {
			updates.push(data);
			if (failures.has(data.revision)) throw new Error(`revision ${data.revision} failed`);
		},
		onDidSelect: selections.event,
	};
	using notifications = new TestNotificationService();
	using control = new NativeMenubarControl(MenuId.MenubarMainMenu, api, menuService, notifications);
	await waitFor(() => updates.length === 1);
	const firstItem = updates[0]!.menus[0]!.items[0];
	assert.equal(firstItem?.type, 'action');
	assert.equal(firstItem.type, 'action');
	assert.ok(firstItem.altId);

	selections.fire({ revision: 1, id: firstItem.altId });
	await waitFor(() => runs.length === 1);
	assert.deepEqual(runs, ['save-as']);

	failures.add(2);
	failures.add(3);
	changes.fire({ isStructuralChange: true, isEnablementChange: false, isToggleChange: false });
	changes.fire({ isStructuralChange: true, isEnablementChange: false, isToggleChange: false });
	await waitFor(() => updates.length === 3);
	selections.fire({ revision: 1, id: firstItem.id });
	await waitFor(() => runs.length === 2);
	assert.deepEqual(runs, ['save-as', 'save']);

	commandFailure = new Error('Save or revert unsaved files before changing their workspace folder.');
	selections.fire({ revision: 1, id: firstItem.id });
	await waitFor(() => notifications.model.getNotifications().length === 1);
	assert.equal(notifications.model.getNotifications()[0]!.message, commandFailure.message);
	commandFailure = new CancellationError();
	selections.fire({ revision: 1, id: firstItem.id });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(notifications.model.getNotifications().length, 1, 'cancellation is silent');

	changes.dispose();
	selections.dispose();
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw new Error('Timed out waiting for menubar state');
}
