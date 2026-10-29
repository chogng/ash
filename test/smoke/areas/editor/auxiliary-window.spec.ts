import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';

// Window switching must transfer OS focus to the detached editor.
const focusTest = test.extend({ electronWindowMode: 'active' });

for (const scenario of [
	{ mode: 'move', locale: 'en', keyboard: false },
	{ mode: 'copy', locale: 'en', keyboard: true },
	{ mode: 'copy', locale: 'zh-CN', keyboard: true },
] as const) {
	test(`tab context menu ${scenario.mode === 'move' ? 'moves' : 'copies'} the clicked editor into a new window in ${scenario.locale}`, async ({ workbench, application, restartWorkbench }) => {
		if (scenario.locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ workbench, application } = await restartWorkbench());
		}
		const page = workbench.page;
		await page.keyboard.press('ControlOrMeta+N');
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		await workbench.editors.groupAt(0).editor.waitForTypeInEditor('selected tab content');
		const instanceId = await workbench.editors.groupAt(0).tabs.last().evaluate(element => element.closest<HTMLElement>('.ash-tab')!.dataset.actionId!);
		await page.keyboard.press('ControlOrMeta+N');
		const tab = page.locator(`.ash-tab[data-action-id="${instanceId}"]`).getByRole('tab');
		await expect(tab).toHaveAttribute('aria-selected', 'false');
		const remainingId = await workbench.editors.groupAt(0).element.locator('.ash-tab-label[aria-selected="true"]').evaluate(element => element.closest<HTMLElement>('.ash-tab')!.dataset.actionId!);
		const remainingTab = page.locator(`.ash-tab[data-action-id="${remainingId}"]`).getByRole('tab');
		const openMenu = async () => {
			if (scenario.keyboard) {
				await tab.focus();
				await tab.press('Shift+F10');
			} else {
				await tab.click({ button: 'right' });
			}
		};
		const labels = scenario.locale === 'en' ? ['Move into New Window', 'Copy into New Window'] : ['移至新窗口', '复制到新窗口'];
		const menu = await workbench.menus.inspect(application, openMenu);
		const splitIndex = menu.findIndex(item => item.label === (scenario.locale === 'en' ? 'Split' : '拆分'));
		const moveIndex = menu.findIndex(item => item.label === labels[0]);
		expect(splitIndex).toBeGreaterThanOrEqual(0);
		expect(moveIndex).toBeGreaterThan(splitIndex);
		expect(menu.slice(moveIndex, moveIndex + 2).map(item => ({ label: item.label, enabled: item.enabled }))).toEqual(labels.map(label => ({ label, enabled: true })));
		const opened = page.context().waitForEvent('page');
		await workbench.menus.select(application, openMenu, [labels[scenario.mode === 'move' ? 0 : 1]!]);
		const popup = await opened;
		try {
			const input = popup.locator('.stanza-editor-input').first();
			await expect(popup.locator('.view-lines')).toContainText('selected tab content');
			await expect(input).toBeFocused();
			if (scenario.locale === 'zh-CN') {
				const titlebar = popup.locator('.ash-auxiliary-titlebar');
				await titlebar.getByRole('button', { name: '开启紧凑模式', exact: true }).click();
				await expect(popup.locator('.ash-workbench-statusbar')).toBeHidden();
				await titlebar.getByRole('button', { name: '关闭紧凑模式', exact: true }).click();
				await expect(popup.locator('.ash-workbench-statusbar')).toBeVisible();
			}
			await expect(tab).toHaveCount(scenario.mode === 'move' ? 0 : 1);
			await expect(remainingTab).toHaveCount(1);
			const popupId = await popup.getByRole('tab').first().evaluate(element => element.closest<HTMLElement>('.ash-tab')!.dataset.actionId!);
			expect(popupId === instanceId).toBe(scenario.mode === 'move');
			if (scenario.mode === 'copy') {
				await input.press('ControlOrMeta+A');
				await popup.keyboard.insertText('shared unsaved content');
				await tab.click();
				await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('shared unsaved content'));
			}
		} finally {
			if (!popup.isClosed()) await popup.close();
		}
		await expect(tab).toHaveCount(1);
		await expect(remainingTab).toHaveCount(1);
	});
}

test('detached editor window inherits workbench theme and accessibility state', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	await expect(workbench.editors.groupAt(0).tabs.last()).toContainText('Untitled');
	// Only dirty editors return to the main window when the auxiliary window closes.
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.editors.groupAt(0).editor.waitForTypeInEditor('retained detached draft');

	const popupPromise = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const popup = await popupPromise;
	try {
		const root = popup.locator('.ash-auxiliary-window-container');
		await expect(root.locator('.ash-workbench-editor')).toBeVisible();
		const sameElementRealm = await root.evaluate(element => element.firstElementChild?.constructor === element.constructor);
		expect(sameElementRealm).toBe(true);
		const mainAppearance = await page.locator('.ash-workbench').first().evaluate(element => ({
			scheme: element.getAttribute('data-color-scheme'),
			os: element.getAttribute('data-os'),
			reducedMotion: element.classList.contains('ash-reduce-motion'),
			background: getComputedStyle(element).backgroundColor,
			foreground: getComputedStyle(element).color,
		}));
		await expect.poll(() => root.evaluate(element => ({
			scheme: element.getAttribute('data-color-scheme'),
			os: element.getAttribute('data-os'),
			reducedMotion: element.classList.contains('ash-reduce-motion'),
			background: getComputedStyle(element).backgroundColor,
			foreground: getComputedStyle(element).color,
		}))).toEqual(mainAppearance);
		await popup.keyboard.press('F1');
		await expect(popup.locator('.ash-quick-pick')).toBeVisible();
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await popup.keyboard.press('Escape');
		await expect(popup.locator('.stanza-editor-input').first()).toBeFocused();
		await popup.keyboard.press('ControlOrMeta+f');
		await expect(popup.locator('.stanza-editor-find-widget')).toBeVisible();
		await popup.keyboard.press('Escape');
		await popup.evaluate(() => { window.resizeTo(700, 530); window.moveTo(120, 90); });
		const previousBounds = await popup.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight, left: window.screenX, top: window.screenY }));
		await popup.evaluate(() => window.close());
		await expect.poll(() => popup.isClosed()).toBe(true);
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(1);
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'retained detached draft');
		const reopenedPromise = page.context().waitForEvent('page');
		await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
		const reopened = await reopenedPromise;
		try {
			await expect(reopened.locator('.ash-auxiliary-window-container .ash-workbench-editor')).toBeVisible();
			await expect.poll(() => reopened.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight, left: window.screenX, top: window.screenY }))).toEqual(previousBounds);
		} finally {
			if (!reopened.isClosed()) await reopened.close();
		}
	} finally {
		if (!popup.isClosed()) await popup.close();
	}
});

focusTest('detached editor windows participate in desktop window switching and close-other-windows', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ workbench, application }) => {
	if (!('windows' in application)) {
		throw new Error('Expected an Electron application');
	}
	const page = workbench.page;
	const mainWindow = await application.browserWindow(page);
	const mainWindowId = await mainWindow.evaluate(window => window.id);
	await mainWindow.dispose();
	const focusMain = async (): Promise<void> => {
		await page.evaluate(async id => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown>; }; }; }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'focus', windowId: id });
		}, mainWindowId);
		await waitForElectronWindowState(application, page, { focused: true });
	};
	await page.keyboard.press('ControlOrMeta+N');
	await expect(workbench.editors.groupAt(0).tabs.last()).toContainText('Untitled');
	// Only dirty editors return to the main window when the auxiliary window closes.
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.editors.groupAt(0).editor.waitForTypeInEditor('retained detached draft');
	const opened = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const popup = await opened;
	let otherWindow: Page | undefined;
	try {
		await expect(popup.locator('.ash-auxiliary-window-container .ash-workbench-editor')).toBeVisible();
		await expect(popup.getByRole('tab', { name: 'Untitled-1, unsaved changes', exact: true })).toBeVisible();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(0);
		await waitForElectronWindowState(application, popup, { focused: true });
		const title = await popup.title();
		await focusMain();
		await workbench.quickaccess.runCommand('workbench.action.switchWindow');
		await expect(workbench.quickaccess.input).toHaveAttribute('placeholder', 'Select a window');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveCount(2);
		await page.locator('.ash-quick-pick-row-label').filter({ hasText: title }).click();
		await waitForElectronWindowState(application, popup, { focused: true });

		await focusMain();
		otherWindow = await workbench.openAgentsWindow('electron');
		await focusMain();
		await workbench.quickaccess.runCommand('workbench.action.closeOtherWindows');
		await expect.poll(() => otherWindow!.isClosed()).toBe(true);
		// Auxiliary editors belong to this Workbench, so closing other Workbenches keeps them.
		expect(popup.isClosed()).toBe(false);
		await workbench.quickaccess.runCommand('workbench.action.switchWindow');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveCount(2);
		await workbench.quickaccess.close();
		await popup.evaluate(() => window.close());
		await expect.poll(() => popup.isClosed()).toBe(true);
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(1);
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'retained detached draft');
		await workbench.quickaccess.runCommand('workbench.action.switchWindow');
		await expect(workbench.quickaccess.input).toHaveAttribute('placeholder', 'Select a window');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveCount(1);
		await workbench.quickaccess.close();
	} finally {
		if (otherWindow && !otherWindow.isClosed()) await otherWindow.close();
		if (!popup.isClosed()) {
			await popup.close();
		}
	}
});

test('detached window titlebar follows its own editor and reserves layout space', async ({ application, target, workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.editors.groupAt(0).editor.waitForTypeInEditor('auxiliary compact fixture');
	const popupPromise = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const popup = await popupPromise;
	try {
		const root = popup.locator('.ash-auxiliary-window-container');
		await expect(root.locator('.ash-workbench-editor')).toBeVisible();

		const titlebar = root.locator('.ash-auxiliary-titlebar');
		await expect(titlebar).toBeVisible();
		await expect(popup).toHaveTitle(/Untitled/);
		await expect(titlebar.locator('.ash-titlebar-command-center-button')).toHaveAttribute('aria-description', await popup.title());
		await expect(titlebar.locator('[data-action-id="workbench.action.toggleSideBar"]')).toHaveCount(0);
		await expect(titlebar.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"]')).toHaveCount(0);
		await expect(page.locator('[data-action-id="workbench.action.toggleSideBar"]')).toBeVisible();
		const mainTitle = await page.title();
		await popup.locator('.stanza-editor-input').first().focus();
		await expect(page).toHaveTitle(mainTitle);
		const bounds = await root.evaluate(element => {
			const title = element.querySelector('.ash-auxiliary-titlebar')!.getBoundingClientRect();
			const editor = element.querySelector('.ash-workbench-editor')!.getBoundingClientRect();
			const status = element.querySelector('.ash-workbench-statusbar')!.getBoundingClientRect();
			return { titleHeight: title.height, titleBottom: title.bottom, editorTop: editor.top, editorBottom: editor.bottom, statusTop: status.top, statusBottom: status.bottom, windowHeight: element.ownerDocument.defaultView!.innerHeight };
		});
		expect(bounds.titleHeight).toBeGreaterThan(0);
		expect(Math.abs(bounds.titleBottom - bounds.editorTop)).toBeLessThanOrEqual(1);
		expect(Math.abs(bounds.editorBottom - bounds.statusTop)).toBeLessThanOrEqual(1);
		expect(Math.abs(bounds.statusBottom - bounds.windowHeight)).toBeLessThanOrEqual(1);

		const enableCompact = titlebar.getByRole('button', { name: 'Turn On Compact Mode', exact: true });
		const regularModeButtonBounds = (await enableCompact.boundingBox())!;
		await enableCompact.focus();
		await enableCompact.press('Enter');
		const disableCompact = titlebar.getByRole('button', { name: 'Turn Off Compact Mode', exact: true });
		await expect(disableCompact).toBeVisible();
		const compactModeButtonBounds = (await disableCompact.boundingBox())!;
		expect(Math.abs(compactModeButtonBounds.x - regularModeButtonBounds.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(compactModeButtonBounds.y - regularModeButtonBounds.y)).toBeLessThanOrEqual(1);
		await expect(popup.locator('.stanza-editor-input').first()).toBeFocused();
		await expect(root.locator('.ash-workbench-statusbar')).toBeHidden();
		await expect(popup.getByRole('tab')).toHaveCount(0);
		await expect(titlebar.locator('.ash-titlebar-command-center-button')).toBeHidden();
		const compactTitle = titlebar.locator('.ash-titlebar-window-title');
		await expect(compactTitle).toBeVisible();
		await expect(compactTitle).toHaveText(await popup.title());
		const titleBounds = (await compactTitle.boundingBox())!;
		const windowWidth = await popup.evaluate(() => window.innerWidth);
		expect(Math.abs(titleBounds.x + titleBounds.width / 2 - windowWidth / 2)).toBeLessThanOrEqual(1);
		expect(titleBounds.x + titleBounds.width).toBeLessThan(compactModeButtonBounds.x);
		await expect(page.locator('.ash-workbench-statusbar')).toBeVisible();
		const compactBottom = await root.locator('.ash-workbench-editor').evaluate(element => element.getBoundingClientRect().bottom);
		expect(Math.abs(compactBottom - bounds.windowHeight)).toBeLessThanOrEqual(1);
		await popup.screenshot({ path: test.info().outputPath('compact-window.png') });
		const originalSize = await popup.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
		const originalViewport = popup.viewportSize();
		const desktopWindow = 'windows' in application ? await application.browserWindow(popup) : undefined;
		const originalHostBounds = await desktopWindow?.evaluate(window => window.getBounds());
		const narrowWidth = target.kind === 'browser' ? 320 : 500;
		try {
			if (target.kind === 'browser') {
				// Headless Chromium fixes the viewport independently of window.resizeTo.
				await popup.setViewportSize({ width: narrowWidth, height: 530 });
			} else {
				await desktopWindow!.evaluate(window => window.setBounds({ ...window.getBounds(), width: 500, height: 530 }));
			}
			await expect.poll(() => popup.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(narrowWidth);
			await expect(compactTitle).toHaveAttribute('title', await popup.title());
			await expect(compactTitle).toHaveCSS('text-overflow', 'ellipsis');
			expect(await compactTitle.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		} finally {
			if (target.kind === 'browser') {
				await popup.setViewportSize(originalViewport!);
			} else {
				// DOM outer dimensions include Windows' invisible frame; restore in the host's DIP space.
				await desktopWindow!.evaluate((window, bounds) => window.setBounds(bounds), originalHostBounds!);
				await desktopWindow!.dispose();
			}
		}
		if (target.kind === 'browser') {
			await expect.poll(() => popup.evaluate(() => window.innerWidth)).toBe(originalViewport!.width);
		} else {
			await expect.poll(() => popup.evaluate(() => window.outerWidth)).toBe(originalSize.width);
		}
		await disableCompact.focus();
		await disableCompact.press('Enter');
		await expect(enableCompact).toBeVisible();
		await expect(popup.locator('.stanza-editor-input').first()).toBeFocused();
		await expect(root.locator('.ash-workbench-statusbar')).toBeVisible();
		await expect(popup.getByRole('tab')).toHaveCount(1);
		await expect(titlebar.locator('.ash-titlebar-command-center-button')).toBeVisible();
		await expect(compactTitle).toBeHidden();
		await popup.screenshot({ path: test.info().outputPath('regular-window.png') });

		await popup.close();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(1);
	} finally {
		if (!popup.isClosed()) await popup.close();
	}
});
