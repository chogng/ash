import { expect, type Locator, type Page } from "@playwright/test";
import { Editor } from './editor.js';
import type { StartupDeadline } from './startupDeadline.js';

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

	async waitForReady(deadline: StartupDeadline): Promise<void> {
		await this.element.waitFor({ state: "visible", timeout: deadline.remaining('editor group') });
		await this.title.waitFor({ state: "visible", timeout: deadline.remaining('editor title') });
		await this.content.waitFor({ state: "visible", timeout: deadline.remaining('editor content') });
	}

	async getTabIds(): Promise<string[]> {
		return this.tabs.evaluateAll(elements => elements.map(element => element.id));
	}

	/** Observes a batch without issuing or serializing the commands under test. */
	async waitForNewTextEditors(previousIds: readonly string[], count: number): Promise<Locator[]> {
		const ids = await waitForNewTextEditorIds(this.tabs, previousIds, count);
		return ids.map(id => this.element.locator(`[id=${JSON.stringify(id)}]`));
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

		const [openedId] = await waitForNewTextEditorIds(tabs, previousIds, 1);
		return this.element.locator(`[id=${JSON.stringify(openedId)}]`);
	}

	async waitForReady(deadline: StartupDeadline): Promise<void> {
		await this.element.waitFor({ state: "visible", timeout: deadline.remaining('editor area') });
		await this.groupAt(0).waitForReady(deadline);
	}
}

async function waitForNewTextEditorIds(tabs: Locator, previousIds: readonly string[], count: number): Promise<string[]> {
	let openedIds: string[] = [];
	await expect.poll(async () => {
		// Startup editors may remain or be replaced. Only new identities count toward this action.
		const opened = await tabs.evaluateAll((elements, previous) => elements.filter(tab => !previous.includes(tab.id)).map(tab => {
			const panel = tab.ownerDocument.getElementById(tab.getAttribute('aria-controls') ?? '');
			const focused = tab.ownerDocument.activeElement;
			return {
				id: tab.id,
				selected: tab.getAttribute('aria-selected') === 'true',
				visible: panel !== null && !panel.hidden,
				hasInput: panel !== null && panel.querySelector('.stanza-editor-input') !== null,
				inputFocused: panel !== null && focused !== null && panel.contains(focused) && focused.matches('.stanza-editor-input'),
			};
		}), previousIds);
		openedIds = opened.map(tab => tab.id);
		return opened;
	}, { message: `exactly ${count} new text editors are open and the final editor owns focus` }).toMatchObject(
		Array.from({ length: count }, (_, index) => index === count - 1
			? { hasInput: true, selected: true, visible: true, inputFocused: true }
			: { hasInput: true }),
	);
	return openedIds;
}
