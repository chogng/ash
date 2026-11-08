import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../../../base/common/platform.js';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { installEditorTestDom } from '../../../../../../../editor/test/browser/editorTestGlobals.js';
import { BrowserContextViewService } from '../../../../../../../platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';
import { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { IProjectService } from '../../../../../../../platform/projects/common/projectService.js';
import { IConnectorService } from '../../../../../../../platform/connectors/common/connectorService.js';
import { IPluginManagementService } from '../../../../../../../platform/extensionManagement/common/pluginManagementService.js';
import { setARIAContainer } from '../../../../../../../base/browser/ui/aria/aria.js';
import { ChatInputAttachMenu } from '../../../../browser/widget/input/chatInputAttachMenu.js';

function createFixture(listConnectors?: IConnectorService['list']) {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body><div id="container" class="ash-sessions-window"><button id="attach-btn" aria-haspopup="menu"></button><input></div></body>', {
		url: 'http://localhost/',
	});
	resources.add(toDisposable(() => dom.window.close()));
	resources.add(installEditorTestDom(dom, ['Node']));
	resources.add(setARIAContainer(dom.window.document.body));

	const services = resources.add(new InstantiationService());

	const document = dom.window.document;
	const container = document.getElementById('container')!;
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(container)));

	const executedCommands: string[] = [];
	const commandService: Partial<ICommandService> = {
		async executeCommand<T = unknown>(id: string, ..._args: readonly unknown[]): Promise<T> {
			executedCommands.push(id);
			return undefined as T;
		},
	};
	services.registerInstance(ICommandService, commandService as ICommandService);

	const storageValues = new Map<string, any>();
	const storageService: Partial<IStorageService> = {
		getBoolean(key: string, _scope: StorageScope, fallbackValue?: boolean): any {
			return storageValues.has(key) ? Boolean(storageValues.get(key)) : (fallbackValue ?? false);
		},
		store(key: string, value: any, _scope?: StorageScope, _target?: StorageTarget) {
			storageValues.set(key, value);
		},
	};
	services.registerInstance(IStorageService, storageService as IStorageService);

	const projectService: Partial<IProjectService> = {
		async list(_filter?: string) {
			return [
				{ id: 'proj-1', name: 'Alpha Project', archived: false } as any,
				{ id: 'proj-2', name: 'Beta Project', archived: false } as any,
			];
		},
	};
	services.registerInstance(IProjectService, projectService as IProjectService);

	const connectorService: Partial<IConnectorService> = {
		list: listConnectors ?? (async () => {
			return {
				connectors: [
					{ id: 'conn-github', displayName: 'GitHub' } as any,
				],
			} as any;
		}),
	};
	services.registerInstance(IConnectorService, connectorService as IConnectorService);

	const pluginService: Partial<IPluginManagementService> = {
		async list() {
			return {
				packages: [
					{ id: 'plugin-tools', displayName: 'Dev Tools' } as any,
				],
			} as any;
		},
	};
	services.registerInstance(IPluginManagementService, pluginService as IPluginManagementService);

	const anchor = document.getElementById('attach-btn')!;
	const input = document.querySelector('input')!;
	anchor.focus();
	let uploaded = false;
	let closed = false;
	const attachedSkills: any[] = [];
	const selectedProjects: string[] = [];

	const menu = resources.add(services.createInstance(ChatInputAttachMenu, {
		anchor,
		focusInput: () => input.focus(),
		onUploadFiles: () => { uploaded = true; },
		onClose: () => { closed = true; },
		onAttachSkill: (skill: any) => { attachedSkills.push(skill); },
		onSelectProject: (id: string) => { selectedProjects.push(id); },
		getSkills: () => [
			{ name: 'Unit Testing', skill: { name: 'Unit Testing' } as any },
		],
	}));

	return {
		document,
		input,
		anchor,
		key(key: string) {
			document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		},
		popup(label = 'Add content or context') {
			return container.querySelector<HTMLElement>(`.ash-context-view-menu:not([hidden]) > .ash-menu[aria-label="${label}"]`);
		},
		menu,
		executedCommands,
		storageValues,
		attachedSkills,
		selectedProjects,
		get uploaded() { return uploaded; },
		get closed() { return closed; },
		[Symbol.dispose]() { resources.dispose(); },
	};
}

function menuItem(menu: HTMLElement, label: string): HTMLButtonElement {
	const row = menu.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	assert.ok(row, `Expected a menu item named ${label}`);
	return row;
}

suite('ChatInputAttachMenu', () => {
	test('shows action icons on the left and checks and submenu arrows on the right', () => {
		using f = createFixture();
		f.menu.show();

		assert.equal(f.anchor.getAttribute('aria-expanded'), 'true');
		const menu = f.popup()!;
		assert.equal(menu.getAttribute('role'), 'menu');
		assert.ok(menu.classList.contains('ash-menu-indicators-trailing'));
		assert.equal(menu.querySelectorAll('button').length, 8);
		assert.equal(menu.querySelectorAll('[role="separator"]').length, 2);
		assert.equal(menu.querySelectorAll('.ash-menu-leading-slot [data-ash-icon-id]').length, 8);

		const upload = menuItem(menu, 'Upload or add files');
		assert.equal(upload.getAttribute('role'), 'menuitem');
		assert.equal(upload.querySelector('.ash-menu-keybinding')?.textContent, isMacintosh ? '⌘U' : 'Ctrl+U');
		assert.ok(upload.querySelector('.ash-menu-leading-slot [data-ash-icon-id="paperclip"]'));
		assert.equal(upload.querySelector('.ash-menu-trailing-slot [data-ash-icon-id]'), null);

		for (const label of ['Add to project', 'Skills', 'Add connector', 'Design system', 'Plugins']) {
			const trigger = menuItem(menu, label);
			assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
			assert.ok(trigger.querySelector('.ash-menu-leading-slot [data-ash-icon-id]'));
			assert.ok(trigger.querySelector('.ash-menu-trailing-slot.ash-submenu-indicator [data-ash-icon-id="menu-submenu"]'));
		}
		for (const label of ['Web search', 'Memory']) {
			const toggle = menuItem(menu, label);
			assert.equal(toggle.getAttribute('role'), 'menuitemcheckbox');
			assert.equal(toggle.getAttribute('aria-checked'), 'true');
			assert.ok(toggle.querySelector('.ash-menu-leading-slot [data-ash-icon-id]'));
			assert.ok(toggle.querySelector('.ash-menu-trailing-slot > [data-ash-icon-id="check"]'));
		}
	});

	test('clicking Upload or add files invokes onUploadFiles and closes the menu', () => {
		using f = createFixture();
		f.menu.show();
		menuItem(f.popup()!, 'Upload or add files').click();

		assert.equal(f.uploaded, true);
		assert.equal(f.popup(), null);
		assert.equal(f.anchor.getAttribute('aria-expanded'), 'false');
	});

	test('toggling Web search and Memory keeps the menu open and persists the check states', () => {
		using f = createFixture();
		f.menu.show();
		const menu = f.popup()!;

		for (const [label, key] of [['Web search', 'webSearch'], ['Memory', 'memory']]) {
			const toggle = menuItem(menu, label);
			for (const checked of [false, true]) {
				toggle.click();
				assert.equal(toggle.getAttribute('aria-checked'), String(checked));
				assert.equal(toggle.classList.contains('checked'), checked);
				assert.ok(toggle.querySelector('.ash-menu-leading-slot [data-ash-icon-id]'));
				assert.equal(f.storageValues.get(`ash.chat.attachMenu.${key}.enabled`), checked);
				assert.equal(f.popup(), menu);
			}
		}
	});

	test('keyboard navigation opens a submenu and returns focus through both menu levels', async () => {
		using f = createFixture();
		f.menu.show();
		const menu = f.popup()!;
		const upload = menuItem(menu, 'Upload or add files');
		const projects = menuItem(menu, 'Add to project');
		assert.equal(f.document.activeElement, upload);

		f.key('ArrowDown');
		assert.equal(f.document.activeElement, projects);
		f.key('ArrowUp');
		assert.equal(f.document.activeElement, upload);
		f.key('ArrowDown');
		f.key('ArrowRight');

		await new Promise<void>(resolve => setImmediate(resolve));
		const submenu = f.popup('Add to project')!;
		const firstProject = menuItem(submenu, 'Alpha Project');
		assert.ok(firstProject.querySelector('.ash-menu-leading-slot [data-ash-icon-id]'));
		assert.equal(f.document.activeElement, firstProject);

		f.key('Escape');
		assert.equal(f.popup('Add to project'), null);
		assert.equal(f.document.activeElement, projects);
		f.key('Escape');
		assert.equal(f.popup(), null);
		assert.equal(f.document.activeElement, f.input);
		assert.equal(f.closed, true);
	});

	test('Design system submenu triggers the selected command', async () => {
		using f = createFixture();
		f.menu.show();
		menuItem(f.popup()!, 'Design system').click();
		await new Promise<void>(resolve => setImmediate(resolve));

		const submenu = f.popup('Design system')!;
		assert.deepEqual([...submenu.querySelectorAll('button')].map(button => button.textContent), ['Artifacts', 'Theme editor']);
		menuItem(submenu, 'Artifacts').click();
		assert.deepEqual(f.executedCommands, ['sessions.open.creator']);
		assert.equal(f.popup(), null);
		assert.equal(f.popup('Design system'), null);
	});

	test('Skills submenu attaches the selected skill', async () => {
		using f = createFixture();
		f.menu.show();
		menuItem(f.popup()!, 'Skills').click();
		await new Promise<void>(resolve => setImmediate(resolve));

		const submenu = f.popup('Skills')!;
		assert.equal(submenu.querySelectorAll('button').length, 2);
		assert.ok(menuItem(submenu, 'Browse skills…'));
		menuItem(submenu, 'Unit Testing').click();
		assert.deepEqual(f.attachedSkills, [{ name: 'Unit Testing' }]);
		assert.equal(f.popup(), null);
	});

	test('ignores a connector response from an earlier submenu expansion', async () => {
		type ConnectorCatalog = Awaited<ReturnType<IConnectorService['list']>>;
		const first = new DeferredPromise<ConnectorCatalog>();
		const second = new DeferredPromise<ConnectorCatalog>();
		const requests = [first, second];
		using f = createFixture(() => requests.shift()!.p);
		f.menu.show();
		const trigger = menuItem(f.popup()!, 'Add connector');
		trigger.click();
		f.key('ArrowLeft');
		assert.equal(f.popup('Add connector'), null);
		trigger.click();

		await first.complete({ generation: 1, connectors: [] });
		await new Promise<void>(resolve => setImmediate(resolve));
		const submenu = f.popup('Add connector')!;
		assert.equal(menuItem(submenu, 'Loading…').disabled, true);

		await second.complete({ generation: 2, connectors: [] });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.document.activeElement, menuItem(submenu, 'Browse connectors…'));
	});
});
