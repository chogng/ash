import type { Browser, ElectronApplication, Locator, Page } from "@playwright/test";
import { Editors } from "./editors.js";
import { QuickAccess } from "./quickaccess.js";
import { SettingsEditor } from './settings.js';
import type { PlaywrightTarget } from './testTarget.js';

/** Product-level automation surface for one Ash Workbench window. */
export class Workbench {
	readonly element: Locator;
	readonly editors: Editors;
	readonly quickaccess: QuickAccess;
	readonly settingsEditor: SettingsEditor;

	constructor(readonly page: Page) {
		this.element = page.locator(".ash-workbench");
		this.editors = new Editors(page);
		this.quickaccess = new QuickAccess(page);
		this.settingsEditor = new SettingsEditor(page, this.quickaccess);
	}

	async waitForReady(): Promise<void> {
		await waitForWindowLoad(this.page);
		await this.element.waitFor({ state: "visible" });
		await this.editors.waitForReady();
		await this.waitForUiIdle();
	}

	async reloadWindow(page: Page = this.page): Promise<void> {
		await page.reload();
		await waitForWindowLoad(page);
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
				page.waitForURL('**/sessions/sessions-code.html'),
				page.locator('[data-action-id="ash.code.open-sessions"] button').click(),
			]);
		} else {
			const existing = page.context().pages().find(candidate => new URL(candidate.url()).pathname.endsWith('/sessions-code.html'));
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
	// Host module evaluation awaits the owning Workbench's restoration promise.
	// Re-importing uses that same evaluation without creating another window.
	await page.evaluate(async () => {
		await Promise.all([...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(script => import(script.src)));
	});
}
