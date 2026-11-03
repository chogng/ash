import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/chatInput.page.js';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../../../base/common/actions.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IWorkspacePickerDelegate, IWorkspacePickerItem } from '../../browser/chat.js';
import { WorkspacePickerActionItem } from '../../browser/widget/input/workspacePickerActionItem.js';

function fixture() {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const services = resources.add(new InstantiationService());
	const selectedChanged = resources.add(new Emitter<IWorkspacePickerItem | undefined>());
	const catalogChanged = resources.add(new Emitter<void>());
	const changed = resources.add(new Emitter<void>());
	const choices = [{ uri: URI.file('/folder'), label: 'Folder', isFolder: true }, { uri: URI.file('/project.ash-workspace'), label: 'Project', isFolder: false }];
	let selected: IWorkspacePickerItem | undefined;
	let entries: readonly IActionListItem<IAction>[] = [];
	let menu: IActionListDelegate<IAction> | undefined;
	const commands: string[] = [];
	const delegate: IWorkspacePickerDelegate = {
		getWorkspaces: () => choices, getSelectedWorkspace: () => selected,
		setSelectedWorkspace: workspace => { selected = workspace; selectedChanged.fire(workspace); },
		onDidChangeSelectedWorkspace: selectedChanged.event, onDidChangeWorkspaces: catalogChanged.event,
		openFolderCommand: 'workbench.action.files.openFolder',
	};
	services.registerInstance(ICommandService, { executeCommand: async (id: string) => { commands.push(id); } } as unknown as ICommandService);
	services.registerInstance(INotificationService, { error(error: unknown) { throw error; } } as unknown as INotificationService);
	services.registerInstance(IActionWidgetService, {
		show(_id: string, _preview: boolean, items: readonly IActionListItem<IAction>[], handler: IActionListDelegate<IAction>) { entries = items; menu = handler; },
		hide() { const current = menu; menu = undefined; current?.onHide(); },
	} as unknown as IActionWidgetService);
	const action = { id: 'workspace', label: 'Workspace', tooltip: 'Choose a workspace', icon: Lxicon.folder, enabled: true, run() { } };
	const picker = resources.add(services.createInstance(WorkspacePickerActionItem, action, delegate, changed.event));
	picker.render(dom.window.document.body);
	const button = dom.window.document.querySelector('button')!;
	return {
		picker, button, action, changed, delegate, choices, catalogChanged, commands,
		get selected() { return selected; }, get entries() { return entries; },
		async open() { button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await new Promise<void>(resolve => setImmediate(resolve)); },
		async choose(id: string) { const item = entries.find(entry => entry.item?.id === id)?.item; assert.ok(item); await menu!.onSelect(item); },
		[Symbol.dispose]() { resources.dispose(); },
	};
}

test('Welcome workspace choices read and update the delegate without owning another selection', async () => {
	using f = fixture();
	await f.open();
	assert.deepEqual(f.entries.map(entry => entry.label), ['Folder', 'Project', 'Open Folder…']);
	await f.choose(`workspace.${f.choices[1]!.uri.toString()}`);
	assert.equal(f.selected, f.choices[1]);
	assert.equal(f.button.textContent, 'Project');
	assert.equal(f.button.getAttribute('aria-label'), 'Workspace: Project');
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	await f.open();
	assert.equal(f.entries[1]?.checked, true);
	f.delegate.setSelectedWorkspace(undefined);
	assert.equal(f.button.textContent, 'Workspace');
});

test('Welcome Open Folder executes the host command and disabling retires its popup', async () => {
	using f = fixture();
	await f.open();
	await f.choose('workspace.openFolder');
	assert.deepEqual(f.commands, ['workbench.action.files.openFolder']);
	assert.equal(f.selected, undefined);
	await f.open();
	f.action.enabled = false;
	f.changed.fire();
	assert.equal(f.button.disabled, true);
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
});

test('Catalog replacement closes the Welcome menu and disposal removes delegate listeners', async () => {
	using f = fixture();
	await f.open();
	f.catalogChanged.fire();
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	f.picker.dispose();
	f.delegate.setSelectedWorkspace(f.choices[0]);
	assert.equal(f.button.isConnected, false);
});

test('Remote workspace choices keep their authority in labels without converting them to local paths', async () => {
	using f = fixture();
	const uri = URI.parse('ash-remote://ssh+build/srv/project');
	f.choices.push({ uri, label: 'Remote project', isFolder: true });
	await f.open();
	assert.equal(f.entries.find(entry => entry.item?.id === `workspace.${uri.toString()}`)?.item?.tooltip, uri.toString());
	await f.choose(`workspace.${uri.toString()}`);
	assert.equal(f.selected?.uri.toString(), uri.toString());
});

suite('Workspace picker command in a rendered composer', () => {
	const browser = useBrowserTests();

	for (const locale of ['en', 'zh-CN']) {
		test(`the command opens its existing picker and preserves the draft in ${locale}`, async () => {
			const { page } = browser;
			await page.goto(`/chatInput.html?workspacePicker&locale=${locale}`);
			const input = page.getByRole('textbox').first();
			await input.fill('Keep this draft');
			await page.evaluate(() => window.ashChatInputIntegration.openWorkspace());
			await expect(page.getByRole('menuitemradio', { name: 'Fixture workspace' })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(input).toHaveValue('Keep this draft');
			await page.evaluate(() => window.ashChatInputIntegration.openWorkspace());
			await page.getByRole('menuitemradio', { name: 'Fixture workspace' }).click();
			await expect(page.getByRole('button', { name: /Fixture workspace/ })).toBeVisible();
			await expect(input).toHaveValue('Keep this draft');
			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('submitting'));
			await page.evaluate(() => window.ashChatInputIntegration.openWorkspace());
			await expect(page.getByRole('menuitemradio', { name: 'Fixture workspace' })).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('ready'));
			await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
			await page.evaluate(() => window.ashChatInputIntegration.openWorkspace());
			await expect(page.getByRole('menuitemradio', { name: 'Fixture workspace' })).toHaveCount(0);
		});
	}
});
