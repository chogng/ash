import { expect, type Locator, type Page } from "@playwright/test";
import { Editors } from "./editors.js";
import { QuickAccess } from "./quickaccess.js";
import { StartupDeadline } from './startupDeadline.js';

/** Product-level automation surface for one Ash Workbench window. */
export class Workbench {
	readonly element: Locator;
	readonly editors: Editors;
	readonly quickaccess: QuickAccess;

	constructor(readonly page: Page) {
		this.element = page.locator(".ash-workbench");
		this.editors = new Editors(page);
		this.quickaccess = new QuickAccess(page);
	}

	async waitForReady(deadline = new StartupDeadline()): Promise<void> {
		await deadline.run('Workbench readiness', async () => {
			await this.page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: deadline.remaining('document load') });
			await this.element.waitFor({ state: "visible", timeout: deadline.remaining('Workbench visibility') });
			// Recovery owns readiness; its wait uses the launch budget, not an interaction assertion budget.
			await expect(this.element).toHaveAttribute('aria-busy', 'false', { timeout: deadline.remaining('Workbench restoration') });
			await this.editors.waitForReady(deadline);
			await this.waitForAnimationFrames();
		});
	}

	/** Observes the applied configuration and every visible side/center part without changing focus or layout. */
	async waitForSideBarLocation(location: 'left' | 'right'): Promise<void> {
		await expect.poll(() => this.element.evaluate((root, location) => {
			const readPart = (id: string) => {
				const element = root.querySelector<HTMLElement>(`[data-part="${id}"]`)!;
				const bounds = element.getBoundingClientRect();
				return {
					location: element.classList.contains('sidebar-right') ? 'right' : 'left',
					visible: element.getClientRects().length > 0 && bounds.width > 0 && bounds.height > 0,
					left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
				};
			};
			const sidebar = readPart('sidebar');
			const activitybar = readPart('activitybar');
			const editor = readPart('editor');
			const panel = readPart('panel');
			const centers = [editor, panel].filter(part => part.visible);
			const sides = [sidebar, activitybar].filter(part => part.visible);
			const isOutside = (part: typeof sidebar, center: typeof sidebar) => location === 'right' ? part.left >= center.right : part.right <= center.left;
			return {
				sidebar, activitybar, editor, panel,
				positioned: centers.length > 0 && centers.every(center => sides.every(part => isOutside(part, center))) &&
					(!sidebar.visible || !activitybar.visible || isOutside(activitybar, sidebar)),
			};
		}, location), { message: `Primary Side Bar configuration and visible part geometry are on the ${location}` }).toMatchObject({
			sidebar: { location }, activitybar: { location }, positioned: true,
		});
	}

	/** Allows pending rendering frames to run; this does not await asynchronous command completion. */
	async waitForAnimationFrames(): Promise<void> {
		await this.page.evaluate(() => new Promise<void>(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
	}
}
