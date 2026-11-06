import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { isMacintosh } from '../../../../../../../base/common/platform.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';
import { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { IProjectService } from '../../../../../../../platform/projects/common/projectService.js';
import { IConnectorService } from '../../../../../../../platform/connectors/common/connectorService.js';
import { IPluginManagementService } from '../../../../../../../platform/extensionManagement/common/pluginManagementService.js';
import { setARIAContainer } from '../../../../../../../base/browser/ui/aria/aria.js';
import { ChatInputAttachMenu } from '../../../../browser/widget/input/chatInputAttachMenu.js';
import type { ContextViewOptions } from '../../../../../../../base/browser/ui/contextview/contextview.js';

function createFixture() {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body><div id="container"><button id="attach-btn" aria-haspopup="menu"></button></div></body>', {
		url: 'http://localhost/',
	});
	resources.add(toDisposable(() => dom.window.close()));
	resources.add(setARIAContainer(dom.window.document.body));

	const services = resources.add(new InstantiationService());

	let currentViewOptions: ContextViewOptions | undefined;
	const contextViewService: Partial<IContextViewService> = {
		get container() { return dom.window.document.getElementById('container') as HTMLElement; },
		show(options: ContextViewOptions) {
			currentViewOptions = options;
			dom.window.document.getElementById('container')!.appendChild(options.content);
			return true;
		},
		hide() {
			if (currentViewOptions) {
				currentViewOptions.content.remove();
				currentViewOptions.onHide?.(0 as any);
				currentViewOptions = undefined;
			}
		},
		layout() {},
	};
	services.registerInstance(IContextViewService, contextViewService as IContextViewService);

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
		async list() {
			return {
				connectors: [
					{ id: 'conn-github', displayName: 'GitHub' } as any,
				],
			} as any;
		},
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

	const anchor = dom.window.document.getElementById('attach-btn') as HTMLElement;
	let uploaded = false;
	let closed = false;
	const attachedSkills: any[] = [];
	const selectedProjects: string[] = [];

	const menu = resources.add(services.createInstance(ChatInputAttachMenu, {
		anchor,
		onUploadFiles: () => { uploaded = true; },
		onClose: () => { closed = true; },
		onAttachSkill: (skill: any) => { attachedSkills.push(skill); },
		onSelectProject: (id: string) => { selectedProjects.push(id); },
		getSkills: () => [
			{ name: 'Unit Testing', skill: { name: 'Unit Testing' } as any },
		],
	}));

	return {
		dom,
		anchor,
		menu,
		executedCommands,
		storageValues,
		attachedSkills,
		selectedProjects,
		get uploaded() { return uploaded; },
		get closed() { return closed; },
		get currentViewOptions() { return currentViewOptions; },
		[Symbol.dispose]() { resources.dispose(); },
	};
}

suite('ChatInputAttachMenu', () => {
	test('renders all 8 items and 2 dividers with expected icons and attributes', () => {
		using f = createFixture();
		f.menu.show();

		assert.equal(f.anchor.getAttribute('aria-expanded'), 'true');
		const menuEl = f.currentViewOptions?.content;
		assert.ok(menuEl, 'Menu content should be rendered in ContextView');
		assert.equal(menuEl.getAttribute('role'), 'menu');

		const items = menuEl.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		assert.equal(items.length, 8, 'Expected 8 menu items');

		const dividers = menuEl.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-divider');
		assert.equal(dividers.length, 2, 'Expected 2 dividers');

		// 1. Upload or add files
		assert.match(items[0].textContent ?? '', /Upload or add files/);
		assert.equal(items[0].getAttribute('role'), 'menuitem');
		const shortcut = items[0].querySelector('.ash-chat-attach-menu-item-shortcut');
		assert.equal(shortcut?.textContent, isMacintosh ? '⌘U' : 'Ctrl+U');

		// 2. Add to project
		assert.match(items[1].textContent ?? '', /Add to project/);
		assert.equal(items[1].getAttribute('aria-haspopup'), 'menu');
		assert.ok(items[1].querySelector('.ash-chat-attach-menu-item-arrow'), 'Should have submenu arrow');

		// 3. Skills
		assert.match(items[2].textContent ?? '', /Skills/);
		assert.equal(items[2].getAttribute('aria-haspopup'), 'menu');

		// 4. Add connector
		assert.match(items[3].textContent ?? '', /Add connector/);
		assert.equal(items[3].getAttribute('aria-haspopup'), 'menu');

		// 5. Design system
		assert.match(items[4].textContent ?? '', /Design system/);
		assert.equal(items[4].getAttribute('aria-haspopup'), 'menu');

		// 6. Plugins
		assert.match(items[5].textContent ?? '', /Plugins/);
		assert.equal(items[5].getAttribute('aria-haspopup'), 'menu');

		// 7. Web search
		assert.match(items[6].textContent ?? '', /Web search/);
		assert.equal(items[6].getAttribute('role'), 'menuitemcheckbox');
		assert.equal(items[6].getAttribute('aria-checked'), 'true');
		assert.ok(items[6].querySelector('.ash-chat-attach-menu-item-check:not(.hidden)'));

		// 8. Memory
		assert.match(items[7].textContent ?? '', /Memory/);
		assert.equal(items[7].getAttribute('role'), 'menuitemcheckbox');
		assert.equal(items[7].getAttribute('aria-checked'), 'true');
		assert.ok(items[7].querySelector('.ash-chat-attach-menu-item-check:not(.hidden)'));
	});

	test('clicking Upload or add files invokes onUploadFiles and closes menu', () => {
		using f = createFixture();
		f.menu.show();

		const menuEl = f.currentViewOptions?.content!;
		const uploadItem = menuEl.querySelector<HTMLElement>('.ash-chat-attach-menu-item')!;
		uploadItem.click();

		assert.equal(f.uploaded, true);
		assert.equal(f.currentViewOptions, undefined);
		assert.equal(f.anchor.getAttribute('aria-expanded'), 'false');
	});

	test('toggling Web search and Memory updates state and persists to storage', () => {
		using f = createFixture();
		f.menu.show();

		const menuEl = f.currentViewOptions?.content!;
		const items = menuEl.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		const webSearchItem = items[6];
		const memoryItem = items[7];

		// Toggle Web search off
		webSearchItem.click();
		assert.equal(webSearchItem.getAttribute('aria-checked'), 'false');
		assert.equal(f.storageValues.get('ash.chat.attachMenu.webSearch.enabled'), false);
		const webCheck = webSearchItem.querySelector('.ash-chat-attach-menu-item-check');
		assert.ok(webCheck?.classList.contains('hidden'));

		// Toggle Memory off
		memoryItem.click();
		assert.equal(memoryItem.getAttribute('aria-checked'), 'false');
		assert.equal(f.storageValues.get('ash.chat.attachMenu.memory.enabled'), false);
		const memoryCheck = memoryItem.querySelector('.ash-chat-attach-menu-item-check');
		assert.ok(memoryCheck?.classList.contains('hidden'));

		// Toggle Web search back on
		webSearchItem.click();
		assert.equal(webSearchItem.getAttribute('aria-checked'), 'true');
		assert.equal(f.storageValues.get('ash.chat.attachMenu.webSearch.enabled'), true);
		assert.ok(!webCheck?.classList.contains('hidden'));
	});

	test('keyboard navigation ArrowDown/ArrowUp and Escape', () => {
		using f = createFixture();
		f.menu.show();

		const menuEl = f.currentViewOptions?.content!;
		const items = menuEl.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		assert.ok(items[0].classList.contains('focused'));

		menuEl.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.ok(items[1].classList.contains('focused'));

		menuEl.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		assert.ok(items[0].classList.contains('focused'));

		menuEl.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.equal(f.currentViewOptions, undefined);
		assert.equal(f.closed, true);
	});

	test('Design system submenu opens and triggers command', async () => {
		using f = createFixture();
		f.menu.show();

		const menuEl = f.currentViewOptions?.content!;
		const items = menuEl.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		const designItem = items[4]; // Design system

		// Trigger submenu
		designItem.click();
		await new Promise<void>(resolve => setImmediate(resolve));

		const container = f.dom.window.document.getElementById('container')!;
		const submenu = container.querySelector<HTMLElement>('.ash-chat-attach-submenu');
		assert.ok(submenu, 'Submenu element should be created');

		const subItems = submenu.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		assert.equal(subItems.length, 2);
		assert.match(subItems[0].textContent ?? '', /Artifacts/);
		assert.match(subItems[1].textContent ?? '', /Theme editor/);

		// Click Artifacts
		subItems[0].click();
		assert.deepEqual(f.executedCommands, ['sessions.open.creator']);
		assert.equal(f.currentViewOptions, undefined, 'Menu should close after command execution');
	});

	test('Skills submenu opens and attaches skill', async () => {
		using f = createFixture();
		f.menu.show();

		const menuEl = f.currentViewOptions?.content!;
		const items = menuEl.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		const skillsItem = items[2]; // Skills

		// Trigger submenu
		skillsItem.click();
		await new Promise<void>(resolve => setImmediate(resolve));

		const container = f.dom.window.document.getElementById('container')!;
		const submenu = container.querySelector<HTMLElement>('.ash-chat-attach-submenu');
		assert.ok(submenu, 'Submenu element should be created');

		const subItems = submenu.querySelectorAll<HTMLElement>('.ash-chat-attach-menu-item');
		// Should have 1 skill item + 1 browse skills item
		assert.equal(subItems.length, 2);
		assert.match(subItems[0].textContent ?? '', /Unit Testing/);
		assert.match(subItems[1].textContent ?? '', /Browse skills/);

		// Click the skill
		subItems[0].click();
		assert.equal(f.attachedSkills.length, 1);
		assert.equal(f.attachedSkills[0].name, 'Unit Testing');
		assert.equal(f.currentViewOptions, undefined);
	});
});
