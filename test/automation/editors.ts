import { expect, type Locator, type Page } from "@playwright/test";
import { Editor } from './editor.js';

/** Product-level automation surface for one editor group. */
export class EditorGroup {
	readonly element: Locator;
	readonly title: Locator;
	readonly content: Locator;
	readonly watermark: Locator;
	readonly welcome: Locator;
	readonly tabs: Locator;
	readonly editor: Editor;

	constructor(element: Locator) {
		this.element = element;
		this.title = element.locator(".ash-editor-title-control");
		this.content = element.locator(".ash-editor-group-content");
		this.watermark = this.content.locator('.ash-editor-group-watermark-shortcuts');
		this.welcome = this.content.locator('.ash-getting-started');
		this.tabs = element.getByRole("tab");
		this.editor = new Editor(this.content);
	}

	async waitForReady(): Promise<void> {
		await this.element.waitFor({ state: "visible" });
		await this.content.waitFor({ state: "visible" });
	}
}

/** Product-level automation surface for the Workbench editor region. */
export class Editors {
	readonly element: Locator;
	readonly groups: Locator;

	constructor(page: Page) {
		this.element = page.locator(".ash-workbench-editor");
		this.groups = this.element.locator(".ash-editor-group");
	}

	groupAt(index: number): EditorGroup {
		return new EditorGroup(this.groups.nth(index));
	}

	async waitForReady(): Promise<void> {
		await this.element.waitFor({ state: "visible" });
		await this.groupAt(0).waitForReady();
	}
}

export async function expectTabActionCentered(item: Locator): Promise<void> {
	const geometry = await item.evaluate(element => {
		const tab = element.getBoundingClientRect();
		const button = element.querySelector('.ash-tab-primary-action button')!.getBoundingClientRect();
		const icon = element.querySelector('.ash-tab-primary-action button svg')!.getBoundingClientRect();
		return {
			buttonOffsetY: button.top + button.height / 2 - tab.top - tab.height / 2,
			iconOffsetX: icon.left + icon.width / 2 - button.left - button.width / 2,
			iconOffsetY: icon.top + icon.height / 2 - button.top - button.height / 2,
		};
	});
	expect(geometry.buttonOffsetY).toBeCloseTo(0, 2);
	expect(geometry.iconOffsetX).toBeCloseTo(0, 2);
	expect(geometry.iconOffsetY).toBeCloseTo(0, 2);
}
