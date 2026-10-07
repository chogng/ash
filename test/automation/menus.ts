import { expect, type Page, type ElectronApplication } from '@playwright/test';
import { DEFAULT_MENU_STYLE, DEFAULT_TITLE_BAR_STYLE, parseMenuStyle, parseTitleBarStyle, resolveContextMenuStyle } from '../../src/ash/platform/window/common/window.js';
import type { PlaywrightApplication } from './playwrightDriver.js';

/** Exercises context menus through their real Browser or Main owner. */
export class Menus {
	constructor(private readonly page: Page) { }

	async select(application: PlaywrightApplication, open: () => Promise<unknown>, path: readonly string[]): Promise<void> {
		if (await this.isSystemMenu(application) && 'windows' in application) {
			await captureElectronMenu(application, open, { label: path.at(-1)!, path });
			return;
		}
		await open();
		for (const label of path.slice(0, -1)) {
			const menus = this.page.getByRole('menu');
			const submenu = menus.nth(await menus.count() - 1).getByRole('menuitem', { name: label, exact: true });
			await submenu.press('ArrowRight');
			await expect(submenu).toHaveAttribute('aria-expanded', 'true');
		}
		await this.page.getByRole('menu').last().getByRole('menuitem', { name: path.at(-1)!, exact: true }).or(
			this.page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: path.at(-1)!, exact: true }),
		).or(
			this.page.getByRole('menu').last().getByRole('menuitemradio', { name: path.at(-1)!, exact: true }),
		).click();
	}

	async inspect(application: PlaywrightApplication, open: () => Promise<unknown>, path: readonly string[] = []): Promise<readonly ElectronMenuItem[]> {
		if (await this.isSystemMenu(application) && 'windows' in application) {
			let items = await captureElectronMenu(application, open);
			for (const label of path) {
				const item = items.find(item => item.label === label);
				expect(item?.submenu, `submenu ${label}`).toBeDefined();
				items = item!.submenu!;
			}
			return items;
		}
		await open();
		for (const label of path) {
			const menus = this.page.getByRole('menu');
			const submenu = menus.nth(await menus.count() - 1).getByRole('menuitem', { name: label, exact: true });
			await submenu.press('ArrowRight');
			await expect(submenu).toHaveAttribute('aria-expanded', 'true');
		}
		const menu = this.page.getByRole('menu').last();
		await expect(menu).toBeVisible();
		const items = await menu.locator('[role^="menuitem"]').evaluateAll(elements => elements.map(element => ({
			label: element.getAttribute('aria-label') ?? element.textContent!.trim(),
			enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true',
			checked: element.getAttribute('aria-checked') === 'true',
		})));
		for (let level = 0; level <= path.length; level++) { await this.page.keyboard.press('Escape'); }
		return items;
	}

	async isSystemMenu(application: PlaywrightApplication): Promise<boolean> {
		if (!('windows' in application)) { return false; }
		const settings = await this.page.evaluate(async () => {
			const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { document: { source: string; }; };
			return JSON.parse(snapshot.document.source) as Record<string, unknown>;
		});
		// Stored settings omit default values; the product registry owns them.
		return resolveContextMenuStyle(
			parseMenuStyle(settings['window.menuStyle'] ?? DEFAULT_MENU_STYLE),
			parseTitleBarStyle(settings['window.titleBarStyle'] ?? DEFAULT_TITLE_BAR_STYLE),
			process.platform === 'darwin' ? 'macos' : 'desktop',
		) === 'system';
	}
}

export interface ElectronMenuItem {
	readonly label: string;
	readonly enabled: boolean;
	readonly checked: boolean;
	readonly submenu?: readonly ElectronMenuItem[];
}

interface CapturedMenu {
	readonly items: readonly ElectronMenuItem[];
	readonly error?: string;
}

interface MenuCaptureGlobal {
	ashTestMenuCapture?: { readonly restore: () => void; result?: CapturedMenu; };
}

/** Selects only the OS popup item; renderer dispatch, IPC and action execution remain real. */
export async function captureElectronMenu(application: ElectronApplication, trigger: () => Promise<unknown>, selection?: { readonly label: string; readonly checked?: boolean; readonly path?: readonly string[]; }): Promise<readonly ElectronMenuItem[]> {
	await application.evaluate(({ Menu }, selection) => {
		const state = globalThis as MenuCaptureGlobal;
		if (state.ashTestMenuCapture) throw new Error('Another test menu capture is active');
		const popup = Menu.prototype.popup;
		const capture = state.ashTestMenuCapture = { restore: () => { Menu.prototype.popup = popup; } } as NonNullable<MenuCaptureGlobal['ashTestMenuCapture']>;
		Menu.prototype.popup = function (options) {
			capture.restore();
			const snapshot = (items: typeof this.items): ElectronMenuItem[] => items.filter(item => item.type !== 'separator').map(item => ({
				label: item.label, enabled: item.enabled, checked: item.checked,
				...(item.submenu ? { submenu: snapshot(item.submenu.items) } : {}),
			}));
			const items = snapshot(this.items);
			try {
				if (selection) {
					const find = (items: typeof this.items): typeof this.items[number] | undefined => {
						for (const item of items) {
							if (item.label === selection.label) return item;
							const nested = item.submenu && find(item.submenu.items);
							if (nested) return nested;
						}
					};
					let item;
					if (selection.path) {
						let items = this.items;
						for (const label of selection.path) {
							item = items.find(item => item.label === label);
							if (!item) throw new Error(`Expected menu path: ${selection.path.join(' > ')}`);
							items = item.submenu?.items ?? [];
						}
					} else {
						item = find(this.items);
					}
					if (!item || !item.enabled) throw new Error(`Expected enabled menu item: ${selection.label}`);
					if (selection.checked !== undefined && item.checked !== selection.checked) throw new Error(`Unexpected menu checked state: ${selection.label}`);
					item.click(item, options?.window, { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, triggeredByAccelerator: false });
				}
				capture.result = { items };
			} catch (error) {
				// Return failed selections to the runner instead of throwing on Main's event loop.
				capture.result = { items, error: String(error) };
			} finally {
				options?.callback?.();
			}
		};
	}, selection);
	try {
		await trigger();
		await expect.poll(() => application.evaluate(() => Boolean((globalThis as MenuCaptureGlobal).ashTestMenuCapture!.result))).toBe(true);
		const result = await application.evaluate(() => (globalThis as MenuCaptureGlobal).ashTestMenuCapture!.result!);
		if (result.error) throw new Error(result.error);
		return result.items;
	} finally {
		await application.evaluate(() => {
			const state = globalThis as MenuCaptureGlobal;
			state.ashTestMenuCapture!.restore();
			delete state.ashTestMenuCapture;
		});
	}
}
