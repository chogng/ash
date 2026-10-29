import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { JSDOM } from 'jsdom';
import { setHoverDelegate, type IManagedHover } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { StatusbarPart, StatusbarService } from '../../../../../workbench/browser/parts/statusbar/statusbarPart.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import { Event } from '../../../../../base/common/event.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';

test('status bar entries render an icon before their text', () => {
	const document = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' }).window.document;
	using service = new StatusbarService();
	using entry = service.addEntry({ icon: Lxicon.gitBranch, text: 'main', ariaLabel: 'Git branch main' }, { id: 'test.branch', alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, document.body);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.branch"]');
	const label = element?.querySelector<HTMLElement>('.ash-statusbar-item-label');

	assert.ok(element);
	assert.ok(label);
	assert.equal(label.firstElementChild?.tagName.toLowerCase(), 'span');
	assert.equal(element.textContent, 'main');
	assert.equal(element.getAttribute('aria-label'), 'Git branch main');
	assert.equal(label.getAttribute('role'), 'button');
	assert.equal(part.minimumHeight, 32);
	assert.equal(part.maximumHeight, 32);
	assert.equal(part.domNode.getAttribute('role'), 'status');
	assert.equal(part.domNode.getAttribute('aria-live'), 'off');
	assert.deepEqual(
		[...part.domNode.children].map(element => element.className),
		['ash-statusbar-items ash-statusbar-items-left', 'ash-statusbar-items ash-statusbar-items-right'],
	);

	const icon = label.firstElementChild;
	const textNode = label.lastChild;
	entry.update({ icon: Lxicon.gitBranch, text: 'develop', ariaLabel: 'Git branch develop' });
	assert.equal(label.firstElementChild, icon);
	assert.equal(label.lastChild, textNode);
	assert.equal(textNode?.textContent, 'develop');
});

test('status bar entries support accessible icon-only presentation', () => {
	const document = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' }).window.document;
	using service = new StatusbarService();
	using entry = service.addEntry({ icon: Lxicon.remote, text: '', ariaLabel: 'App Server ready', tooltip: 'Connected' }, { id: 'test.remote', alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, document.body);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.remote"]');
	const label = element?.querySelector<HTMLElement>('.ash-statusbar-item-label');

	assert.ok(element);
	assert.ok(label);
	assert.ok(element.querySelector('.ash-icon'));
	assert.equal(element.classList.contains('icon-only'), true);
	assert.equal(element.textContent, '');
	assert.equal(element.getAttribute('aria-label'), 'App Server ready');
	assert.equal(label.title, 'Connected');
});

test('status bar entries render grouped segments inside one action', () => {
	const document = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' }).window.document;
	using service = new StatusbarService();
	using entry = service.addEntry(
		{
			text: '',
			segments: [
				{ icon: Lxicon.error, text: '2' },
				{ icon: Lxicon.warning, text: '1' },
			],
			ariaLabel: 'Errors: 2, Warnings: 1',
		},
		{ id: 'test.problems', alignment: StatusbarAlignment.Left },
	);
	using services = createStatusbarServices(document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, document.body);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.problems"]');
	const label = element?.querySelector<HTMLElement>('.ash-statusbar-item-label');
	const segments = label?.querySelectorAll<HTMLElement>('.ash-statusbar-item-segment');

	assert.ok(element);
	assert.ok(label);
	assert.equal(segments?.length, 2);
	assert.deepEqual(
		[...(segments ?? [])].map(segment => segment.textContent),
		['2', '1'],
	);
	assert.equal(label.querySelectorAll('.ash-icon').length, 2);
	assert.equal(label.getAttribute('aria-label'), 'Errors: 2, Warnings: 1');

	entry.update({
		text: '',
		segments: [
			{ icon: Lxicon.error, text: '3' },
			{ icon: Lxicon.warning, text: '0' },
		],
	});
	assert.equal(element.textContent, '30');
});

test('status bar entries compact adjacent members of the same group', () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const { document } = dom.window;
	using service = new StatusbarService();
	using remote = service.addEntry({ kind: 'remote', text: '', run() {} }, { id: 'test.remote', alignment: StatusbarAlignment.Left, priority: 3 });
	using branch = service.addEntry({ text: 'main', run() {} }, { id: 'test.branch', alignment: StatusbarAlignment.Left, priority: 2, compactGroup: 'git' });
	using sync = service.addEntry({ icon: Lxicon.sync, text: '2↓ 1↑', run() {} }, { id: 'test.sync', alignment: StatusbarAlignment.Left, priority: 1, compactGroup: 'git' });
	using problems = service.addEntry({ text: '0' }, { id: 'test.problems', alignment: StatusbarAlignment.Left, priority: 0 });
	using services = createStatusbarServices(document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, document.body);
	const branchElement = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.branch"]');
	const syncElement = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.sync"]');
	const problemsElement = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.problems"]');

	assert.ok(branchElement);
	assert.ok(syncElement);
	assert.ok(problemsElement);
	const compactGroup = part.domNode.querySelector<HTMLElement>('[data-compact-group="git"]');
	assert.ok(compactGroup);
	assert.deepEqual([...compactGroup.children], [branchElement, syncElement]);
	assert.deepEqual([...(compactGroup.parentElement?.children ?? [])], [part.domNode.querySelector('[data-statusbar-item-id="test.remote"]'), compactGroup, problemsElement]);
	assert.equal(branchElement.classList.contains('compact-left'), false);
	assert.equal(branchElement.classList.contains('compact-right'), true);
	assert.equal(syncElement.classList.contains('compact-left'), true);
	assert.equal(syncElement.classList.contains('compact-right'), false);

	branchElement.querySelector('.ash-statusbar-item-label')?.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
	assert.equal(branchElement.classList.contains('compact-entry-hover'), true);
	assert.equal(syncElement.classList.contains('compact-group-hover'), true);
	assert.equal(syncElement.classList.contains('compact-entry-hover'), false);

	syncElement.querySelector('.ash-statusbar-item-label')?.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
	assert.equal(branchElement.classList.contains('compact-group-hover'), true);
	assert.equal(branchElement.classList.contains('compact-entry-hover'), false);
	assert.equal(syncElement.classList.contains('compact-entry-hover'), true);

	syncElement.querySelector('.ash-statusbar-item-label')?.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
	assert.equal(branchElement.classList.contains('compact-group-hover'), false);
	assert.equal(syncElement.classList.contains('compact-group-hover'), false);
	dom.window.close();
});

test('status bar entry updates retain the item shell and activate commands', () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const { document } = dom.window;
	let activations = 0;
	using service = new StatusbarService();
	using entry = service.addEntry({ text: 'main', run: () => (activations += 1) }, { id: 'test.branch', alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, document.body);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.branch"]');
	const label = element?.querySelector<HTMLElement>('.ash-statusbar-item-label');
	const textNode = label?.firstChild;

	assert.ok(element);
	assert.ok(label);
	assert.equal(label.tabIndex, -1);
	label.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
	assert.equal(activations, 1);

	entry.update({ text: 'detached', run: () => (activations += 1) });
	assert.equal(part.domNode.querySelector('[data-statusbar-item-id="test.branch"]'), element);
	assert.equal(element?.querySelector('.ash-statusbar-item-label'), label);
	assert.equal(label?.firstChild, textNode);
	assert.equal(element.textContent, 'detached');
	dom.window.close();
});

test('status bar items are focused through the part and activate from the keyboard', () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const { document } = dom.window;
	let activations = 0;
	using service = new StatusbarService();
	using first = service.addEntry({ text: 'first', run: () => (activations += 1) }, { id: 'test.first', alignment: StatusbarAlignment.Left, priority: 2 });
	using second = service.addEntry({ text: 'second', run: () => (activations += 1) }, { id: 'test.second', alignment: StatusbarAlignment.Left, priority: 1 });
	using services = createStatusbarServices(document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, document.body);
	document.body.append(part.domNode);
	const content = part.domNode;
	const labels = part.domNode.querySelectorAll<HTMLElement>('.ash-statusbar-item-label');

	assert.equal(content.tabIndex, 0);
	assert.equal(labels[0]?.tabIndex, -1);
	assert.equal(labels[1]?.tabIndex, -1);

	part.focusNextEntry();
	assert.equal(document.activeElement, labels[0]);
	part.focusNextEntry();
	assert.equal(document.activeElement, labels[1]);
	part.focusPreviousEntry();
	assert.equal(document.activeElement, labels[0]);

	const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
	labels[0]?.dispatchEvent(enter);
	assert.equal(enter.defaultPrevented, true);
	assert.equal(activations, 1);

	first.update({ text: 'read-only' });
	const disabledLabel = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.first"] .ash-statusbar-item-label');
	assert.ok(disabledLabel);
	assert.equal(disabledLabel.tabIndex, -1);
	assert.equal(disabledLabel.getAttribute('aria-disabled'), 'true');
	assert.equal(disabledLabel.classList.contains('disabled'), true);
	disabledLabel.click();
	assert.equal(activations, 1);

	dom.window.close();
});

for (const alignment of [StatusbarAlignment.Left, StatusbarAlignment.Right]) {
	test(`status bar ${alignment === StatusbarAlignment.Left ? 'left' : 'right'} entries retain the same focused node through updates and regrouping`, () => {
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		try {
			const { document } = browser.window;
			using service = new StatusbarService();
			using entry = service.addEntry({ text: 'origin', run() {} }, { id: 'test.origin', alignment, priority: 2, compactGroup: 'test.group' });
			using peer = service.addEntry({ text: 'peer', run() {} }, { id: 'test.peer', alignment, priority: 0, compactGroup: 'test.group' });
			using services = createStatusbarServices(document, service);
			using part = services.createInstance(StatusbarPart, document.body);
			document.body.append(part.domNode);
			const origin = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.origin"] .ash-statusbar-item-label')!;
			origin.focus();
			entry.update({ text: 'updated', run() {} });
			assert.equal(document.activeElement, origin);
			using inserted = service.addEntry({ text: 'between', run() {} }, { id: 'test.between', alignment, priority: 1 });
			assert.equal(document.activeElement, origin);
			assert.equal(part.domNode.querySelector('[data-compact-group="test.group"]'), null);
			inserted.dispose();
			assert.equal(document.activeElement, origin);
			assert.ok(part.domNode.querySelector('[data-compact-group="test.group"]')?.contains(origin));
			peer.dispose();
			assert.equal(document.activeElement, origin);
			assert.equal(part.domNode.querySelector('[data-statusbar-item-id="test.origin"] .ash-statusbar-item-label'), origin);
		} finally {
			browser.window.close();
		}
	});
}

test('status bar rendering does not restore a removed focused entry or take outside focus', () => {
	const browser = new JSDOM('<!doctype html><body><button>Outside</button></body>', { url: 'https://ash.test' });
	try {
		const { document } = browser.window;
		using service = new StatusbarService();
		using entry = service.addEntry({ text: 'origin', run() {} }, { id: 'test.origin', alignment: StatusbarAlignment.Left });
		using services = createStatusbarServices(document, service);
		using part = services.createInstance(StatusbarPart, document.body);
		document.body.append(part.domNode);
		const origin = part.domNode.querySelector<HTMLElement>('.ash-statusbar-item-label')!;
		const outside = document.querySelector<HTMLButtonElement>('button')!;
		outside.focus();
		entry.update({ text: 'updated', run() {} });
		assert.equal(document.activeElement, outside);
		origin.focus();
		entry.dispose();
		assert.equal(origin.isConnected, false);
		assert.equal(document.activeElement, document.body);
		using replacement = service.addEntry({ text: 'replacement', run() {} }, { id: 'test.origin', alignment: StatusbarAlignment.Left });
		assert.equal(document.activeElement, document.body);
		assert.notEqual(part.domNode.querySelector('.ash-statusbar-item-label'), origin);
	} finally {
		browser.window.close();
	}
});

test('status bar rendering preserves focus explicitly moved outside during an entry update', () => {
	const browser = new JSDOM('<!doctype html><body><button>Outside</button></body>', { url: 'https://ash.test' });
	try {
		const { document } = browser.window;
		const outside = document.querySelector<HTMLButtonElement>('button')!;
		let moveFocus = false;
		using delegateRegistration = setHoverDelegate({
			setupDelayedHover() {
				throw new Error('Unexpected delayed hover registration');
			},
			setupHover() {
				if (moveFocus) outside.focus();
				return managedHover();
			},
		});
		using service = new StatusbarService();
		using entry = service.addEntry({ text: 'origin', tooltip: 'before', run() {} }, { id: 'test.origin', alignment: StatusbarAlignment.Left });
		using services = createStatusbarServices(document, service);
		using part = services.createInstance(StatusbarPart, document.body);
		document.body.append(part.domNode);
		const origin = part.domNode.querySelector<HTMLElement>('.ash-statusbar-item-label')!;
		origin.focus();
		moveFocus = true;
		entry.update({ text: 'updated', tooltip: 'after', run() {} });
		assert.equal(origin.isConnected, true);
		assert.equal(document.activeElement, outside);
	} finally {
		browser.window.close();
	}
});

test('status bar item tooltips use the managed statusbar hover group', () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const setups: Array<{ target: HTMLElement; content: unknown; groupId?: string }> = [];
	using delegateRegistration = setHoverDelegate({
		setupDelayedHover() {
			throw new Error('Unexpected delayed hover registration');
		},
		setupHover(options) {
			setups.push(options);
			return managedHover();
		},
	});
	using service = new StatusbarService();
	using entry = service.addEntry({ text: 'main', tooltip: 'Git branch main' }, { id: 'test.branch', alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(dom.window.document.body.ownerDocument, service);
	using part = services.createInstance(StatusbarPart, dom.window.document.body);
	const label = part.domNode.querySelector<HTMLElement>('.ash-statusbar-item-label');

	assert.ok(label);
	assert.equal(setups.length, 1);
	assert.equal(setups[0]?.target, label);
	assert.equal(setups[0]?.content, 'Git branch main');
	assert.equal(setups[0]?.groupId, 'statusbar');

	entry.update({ text: 'develop', tooltip: 'Git branch main' });
	assert.equal(setups.length, 1);
	entry.update({ text: 'develop', tooltip: 'Git branch develop' });
	assert.equal(setups.length, 2);

	dom.window.close();
});

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
	};
}

test('hidden status bar entries retain service ownership, current content and persistence across Parts', () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		const { document } = browser.window;
		using service = new StatusbarService();
		using entry = service.addEntry({ text: 'before', run() {} }, { id: 'test.hidden', alignment: StatusbarAlignment.Left });
		using services = createStatusbarServices(document, service);
		using part = services.createInstance(StatusbarPart, document.body);
		part.focusNextEntry();
		part.updateEntryVisibility('test.hidden', false);
		assert.equal(document.activeElement, part.domNode);
		assert.equal(part.domNode.querySelector('[data-statusbar-item-id="test.hidden"]'), null);
		entry.update({ text: 'after', run() {} });
		assert.equal(service.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'after');
		assert.equal(part.domNode.querySelector('[data-statusbar-item-id="test.hidden"]'), null);
		part.dispose();
		using restored = services.createInstance(StatusbarPart, document.body);
		assert.equal(restored.isEntryVisible('test.hidden'), false);
		assert.equal(restored.domNode.querySelector('[data-statusbar-item-id="test.hidden"]'), null);
		restored.updateEntryVisibility('test.hidden', true);
		assert.equal(restored.domNode.querySelector('[data-statusbar-item-id="test.hidden"]')?.textContent, 'after');
		entry.dispose();
		assert.equal(restored.domNode.querySelector('[data-statusbar-item-id="test.hidden"]'), null);
	} finally {
		browser.window.close();
	}
});

function createStatusbarServices(document: Document, statusbar: IStatusbarService): InstantiationService {
	const services = new InstantiationService();
	services.registerInstance(IStatusbarService, statusbar);
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom',
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() {},
		hideContextMenu() {},
	});
	services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	services.registerSingleton(
		IStorageService,
		() =>
			new BrowserStorageService({
				ownerWindow: document.defaultView!,
				workspaceId: 'statusbar-test',
				backend: document.defaultView!.localStorage,
				flushInterval: 0,
			}),
	);
	return registerTestComponentServices(services, document);
}

test('Part saves live state before storage flush and releases theme and save listeners with its DOM', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using entries = new StatusbarService();
		using services = createStatusbarServices(browser.window.document, entries);
		using part = services.createInstance(StatefulStatusbar, browser.window.document.body);
		const storage = services.get(IStorageService);
		const themes = services.get(IThemeService) as TestThemeService;
		assert.equal(part.getId(), 'statusbar');
		assert.equal(part.themeId, darkColorTheme.id);
		themes.setColorTheme(lightColorTheme);
		assert.equal(part.themeId, lightColorTheme.id);
		assert.equal(part.styleUpdates, 1);
		await storage.flush();
		assert.deepEqual(JSON.parse(storage.get('memento/statusbar', StorageScope.WORKSPACE)!), { saves: 1 });
		part.dispose();
		themes.setColorTheme(darkColorTheme);
		await storage.flush();
		assert.equal(part.styleUpdates, 1);
		assert.equal(part.domNode.isConnected, false);
		assert.deepEqual(JSON.parse(storage.get('memento/statusbar', StorageScope.WORKSPACE)!), { saves: 1 });
	} finally {
		browser.window.close();
	}
});

class StatefulStatusbar extends StatusbarPart {
	public styleUpdates = 0;
	private saves = 0;
	public get themeId(): string {
		return this.theme.id;
	}
	public override updateStyles(): void {
		this.styleUpdates++;
	}
	protected override saveState(): void {
		Object.assign(this.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE), { saves: ++this.saves });
	}
}

test('right status entries navigate in their visual left-to-right order', () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using service = new StatusbarService();
	using outer = service.addEntry({ text: 'language', run() {} }, { id: 'test.language', alignment: StatusbarAlignment.Right, priority: 80 });
	using inner = service.addEntry({ text: 'cursor', run() {} }, { id: 'test.cursor', alignment: StatusbarAlignment.Right, priority: 40 });
	using services = createStatusbarServices(dom.window.document, service);
	using part = services.createInstance(StatusbarPart, dom.window.document.body);
	part.focusNextEntry();
	assert.equal(dom.window.document.activeElement?.textContent, 'cursor');
	part.focusNextEntry();
	assert.equal(dom.window.document.activeElement?.textContent, 'language');
	part.focusPreviousEntry();
	assert.equal(dom.window.document.activeElement?.textContent, 'cursor');
	dom.window.close();
});

suite('statusbar browser component', () => {
	const browserTests = useBrowserTests();
	test('status bar entries center their hover area inside the desktop or browser footer', async function () {
		const { page } = browserTests;
		await page.goto('/statusbar.html');
		const bar = page.locator('[data-part="statusbar"]');
		for (const host of [
			{ runtime: 'electron', os: 'windows' },
			{ runtime: 'web', os: 'windows' },
			{ runtime: 'electron', os: 'linux' },
			{ runtime: 'electron', os: 'mac' },
		]) {
			await bar.evaluate((element, host) => {
				const root = element.closest<HTMLElement>('.ash-workbench')!;
				root.dataset.runtime = host.runtime;
				root.dataset.os = host.os;
			}, host);
			const label = page.getByRole('button', { name: 'Branch main', exact: true });
			await label.hover();
			const gaps = await bar.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				return [...element.querySelectorAll('.ash-statusbar-item-label')].map(label => {
					const item = label.getBoundingClientRect();
					return { top: item.top - bounds.top, bottom: bounds.bottom - item.bottom };
				});
			});
			assert.equal(gaps.length, 3);
			for (const gap of gaps) assert.ok(Math.abs(gap.top - gap.bottom) < 0.01, JSON.stringify({ host, gap }));
		}
	});

	test('status bar hides a presentation while retaining its live entry and restores profile visibility after reload', async function () {
		const { page } = browserTests;

		await page.goto('/statusbar.html');
		const branch = page.locator('[data-statusbar-item-id="fixture.branch"]');
		await expect(branch).toHaveText('main');
		await page.evaluate(() => window.ashStatusbarIntegration.setVisibility('fixture.branch', false));
		await expect(branch).toHaveCount(0);
		await page.evaluate(() => window.ashStatusbarIntegration.updateBranch('updated while hidden'));
		expect(await page.evaluate(() => window.ashStatusbarIntegration.entries())).toEqual([{ id: 'fixture.branch', text: 'updated while hidden' }]);
		await page.reload();
		await expect(page.locator('[data-part="statusbar"]')).toBeVisible();
		await expect(branch).toHaveCount(0);
		await page.evaluate(() => window.ashStatusbarIntegration.setVisibility('fixture.branch', true));
		await expect(branch).toHaveText('main');
		await page.reload();
		await expect(branch).toHaveText('main');
	});

	test('status bar context menu hides, restores and persists entries with checked state and keyboard focus', async function () {
		const { page } = browserTests;

		await page.goto('/statusbar.html');
		const bar = page.locator('[data-part="statusbar"]');
		const branch = page.getByRole('button', { name: 'Branch main', exact: true });
		await branch.click({ button: 'right' });
		await page.getByRole('menuitem', { name: "Hide 'Branch main'", exact: true }).click();
		await expect(branch).toHaveCount(0);
		await expect(bar).toBeFocused();
		await page.reload();
		await expect(bar).toBeVisible();
		await expect(branch).toHaveCount(0);
		await bar.focus();
		await page.keyboard.press('Shift+F10');
		const toggle = page.getByRole('menuitemcheckbox', { name: 'Branch main', exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.click();
		await expect(branch).toBeVisible();
		await expect(bar).toBeFocused();
		await branch.focus();
		await page.keyboard.press('Shift+F10');
		await expect(page.getByRole('menuitemcheckbox', { name: 'Branch main', exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await expect(branch).toBeFocused();
		await page.reload();
		await expect(branch).toBeVisible();
	});

	test('status bar commands use real keybindings, visual order, hidden filtering, activation and two-stage Escape', async function () {
		const { page } = browserTests;

		await page.goto('/statusbar.html');
		const bar = page.locator('[data-part="statusbar"]');
		const branch = page.getByRole('button', { name: 'Branch main', exact: true });
		const cursor = page.getByRole('button', { name: 'Cursor', exact: true });
		const language = page.getByRole('button', { name: 'Language', exact: true });
		const editor = page.getByRole('textbox', { name: 'Editor input' });
		await page.evaluate(() => window.ashStatusbarIntegration.command('workbench.action.focusStatusBar'));
		await expect(bar).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(branch).toBeFocused();
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => window.ashStatusbarIntegration.activations)).toBe(1);
		await page.keyboard.press('ArrowDown');
		await expect(cursor).toBeFocused();
		await page.keyboard.press('End');
		await expect(language).toBeFocused();
		await page.keyboard.press('Home');
		await expect(branch).toBeFocused();
		await page.evaluate(() => window.ashStatusbarIntegration.setVisibility('fixture.cursor', false));
		await page.keyboard.press('ArrowRight');
		await expect(language).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(branch).toBeFocused();
		await editor.focus();
		await page.evaluate(() => window.ashStatusbarIntegration.command('workbench.action.focusStatusBar'));
		await expect(branch).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(bar).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await editor.fill('input');
		await page.keyboard.press('Home');
		await expect(editor).toBeFocused();
	});

	test('Chinese status bar labels and menu actions retain theme focus indicators', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/statusbar.html?zh');
		const bar = page.getByRole('status', { name: '状态栏', exact: true });
		await expect(bar).toBeVisible();
		const branch = page.getByRole('button', { name: 'Branch main', exact: true });
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashStatusbarIntegration.theme(index), theme);
			await page.evaluate(() => window.ashStatusbarIntegration.command('workbench.action.focusStatusBar'));
			await page.keyboard.press('Home');
			await expect(branch).toBeFocused();
			await expect(branch).toHaveCSS('outline-style', 'solid');
			await expect(branch).toHaveCSS('outline-width', '1px');
			await page.keyboard.press('Shift+F10');
			await expect(page.getByRole('menuitem', { name: '隐藏“Branch main”', exact: true })).toBeVisible();
			await testInfo.attach(`statusbar-zh-theme-${theme}`, {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
			await page.keyboard.press('Escape');
			await expect(branch).toBeFocused();
		}
	});
});
