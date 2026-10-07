import type { Browser, ElectronApplication, Locator, Page } from "@playwright/test";
import { Editors } from "./editors.js";
import { QuickAccess } from "./quickaccess.js";
import { SettingsEditor } from './settings.js';
import { Terminal } from './terminal.js';
import { Dialogs } from './dialogs.js';
import { Search } from './search.js';
import { Menus } from './menus.js';
import { Git } from './git.js';
import type { PlaywrightTarget } from './testTarget.js';
import { installMainChannelTestClient } from './mainProcessIpc.js';

/** Product-level automation surface for one Ash Workbench window. */
export class Workbench {
	readonly element: Locator;
	readonly editors: Editors;
	readonly quickaccess: QuickAccess;
	readonly settingsEditor: SettingsEditor;
	readonly terminal: Terminal;
	readonly dialogs: Dialogs;
	readonly search: Search;
	readonly menus: Menus;
	readonly git: Git;

	constructor(readonly page: Page) {
		this.element = page.locator(".ash-workbench");
		this.editors = new Editors(page);
		this.quickaccess = new QuickAccess(page);
		this.settingsEditor = new SettingsEditor(page, this.quickaccess);
		this.terminal = new Terminal(page);
		this.dialogs = new Dialogs(page);
		this.search = new Search(page);
		this.menus = new Menus(page);
		this.git = new Git(page, this.menus);
	}

	async waitForReady(): Promise<void> {
		await waitForWindowLoad(this.page);
		await this.element.waitFor({ state: "visible" });
		await this.editors.waitForReady();
		await this.waitForUiIdle();
	}

	/** Recreates the renderer realm; use the reloadWorkbench fixture for a normal close/reopen. */
	async reloadWindow(page: Page = this.page): Promise<void> {
		await page.reload();
		await waitForWindowLoad(page);
	}

	/** System appearance belongs to Main on Electron and media queries on Browser. */
	async setAppearance(application: Browser | ElectronApplication, colorScheme: 'light' | 'dark', page = this.page): Promise<void> {
		if ('windows' in application) {
			await application.evaluate(({ nativeTheme }, scheme) => { nativeTheme.themeSource = scheme; }, colorScheme);
		} else {
			await page.emulateMedia({ colorScheme });
		}
	}

	async openExplorer(): Promise<void> {
		const sidebar = this.page.locator('[data-part="sidebar"]');
		const explorer = this.page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Explorer', exact: true });
		if (await explorer.getAttribute('aria-selected') !== 'true' || !await sidebar.isVisible()) {
			await explorer.click();
		}
		await sidebar.waitFor({ state: 'visible' });
		await this.page.locator('[data-part="sidebar"] .ash-sidebar-title-label').getByText('Explorer', { exact: true }).waitFor({ state: 'visible' });
	}

	async reopenAgentsWindow(application: Browser | ElectronApplication, page: Page): Promise<Page> {
		if ('windows' in application) {
			// Desktop persistence joins the real close handshake; CDP page.reload
			// destroys the renderer before its asynchronous shutdown can finish.
			const window = await application.browserWindow(page);
			const closed = page.waitForEvent('close');
			await window.evaluate(window => window.close());
			await closed;
			return this.openAgentsWindow('electron');
		}
		await this.reloadWindow(page);
		return page;
	}

	async openAgentsWindow(kind: PlaywrightTarget['kind']): Promise<Page> {
		let page = this.page;
		if (kind === 'browser') {
			await Promise.all([
				page.waitForURL('**/sessions/sessions.html'),
				page.locator('[data-action-id="ash.code.open-sessions"] button').click(),
			]);
		} else {
			const existing = page.context().pages().find(candidate => new URL(candidate.url()).pathname.endsWith('/sessions/electron-browser/sessions.html'));
			[page] = await Promise.all([
				existing ? Promise.resolve(existing) : page.context().waitForEvent('page'),
				page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click(),
			]);
		}
		await waitForWindowLoad(page);
		await page.locator('.ash-sessions-window').waitFor({ state: 'visible' });
		return page;
	}

	async waitForUiIdle(): Promise<void> {
		await this.page.evaluate(() => new Promise<void>(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
	}
}

async function waitForWindowLoad(page: Page): Promise<void> {
	await page.waitForFunction(() => document.readyState === 'complete');
	await installMainChannelTestClient(page);
	// Host module evaluation awaits the owning Workbench's restoration promise.
	// Re-importing uses that same evaluation without creating another window.
	await page.evaluate(async () => {
		await Promise.all([...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(script => import(script.src)));
	});
}
