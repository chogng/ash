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
		await this.title.waitFor({ state: "visible" });
		await this.content.waitFor({ state: "visible" });
	}
}

/** Product-level automation surface for the Workbench editor region. */
export class Editors {
	readonly element: Locator;
	readonly groups: Locator;

	constructor(private readonly page: Page) {
		this.element = page.locator(".ash-workbench-editor");
		this.groups = this.element.locator(".ash-editor-group");
	}

	groupAt(index: number): EditorGroup {
		return new EditorGroup(this.groups.nth(index));
	}

	/** Opens in the active group and returns only after the new text editor owns focus. */
	async newUntitledFile(open = () => this.page.keyboard.press('ControlOrMeta+N')): Promise<Locator> {
		const tabs = this.element.getByRole('tab');
		const previousIds = await tabs.evaluateAll(elements => elements.map(element => element.id));
		await open();

		// A replaced Welcome tab can leave the count unchanged; the previous input can remain focused while loading.
		let openedId = '';
		await expect.poll(async () => {
			openedId = await tabs.evaluateAll((elements, previous) => {
				const opened = elements.find(tab => {
					if (previous.includes(tab.id) || tab.getAttribute('aria-selected') !== 'true') return false;
					const panel = tab.ownerDocument.getElementById(tab.getAttribute('aria-controls') ?? '');
					const focused = tab.ownerDocument.activeElement;
					return panel !== null && !panel.hidden && focused !== null && panel.contains(focused) && focused.matches('.stanza-editor-input');
				});
				return opened?.id ?? '';
			}, previousIds);
			return openedId;
		}, { message: 'new untitled tab is selected and its text editor is focused' }).not.toBe('');
		return this.element.locator(`[id=${JSON.stringify(openedId)}]`);
	}

	async waitForReady(): Promise<void> {
		await this.element.waitFor({ state: "visible" });
		await this.groupAt(0).waitForReady();
	}
}
