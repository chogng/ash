import { expect, type Locator } from '@playwright/test';

/** Text editing automation scoped to the active editor in one group. */
export class Editor {
	readonly element: Locator;
	readonly input: Locator;
	readonly lines: Locator;

	constructor(content: Locator) {
		// Groups retain inactive editor panes, so every operation follows the visible one.
		this.element = content.locator('.stanza-editor:visible');
		this.input = this.element.locator('.stanza-editor-input');
		this.lines = this.element.locator('.view-lines > .view-line .stanza-editor-line-text');
	}

	async waitForEditorFocus(): Promise<void> {
		await expect(this.element).toBeVisible();
		await this.input.focus();
		await expect(this.input).toBeFocused();
	}

	async waitForTypeInEditor(text: string): Promise<void> {
		if (text.includes('\n') || text.includes('\r')) {
			throw new Error('waitForTypeInEditor accepts one line; press Enter between lines so editor indentation is applied explicitly');
		}
		await expect(this.input).toBeFocused();
		await this.input.page().keyboard.insertText(text);
		await this.waitForEditorContents(contents => contents.includes(text));
	}

	/** Checks rendered viewport text; folded and offscreen model lines are absent. */
	async waitForEditorContents(accept: (contents: string) => boolean): Promise<void> {
		await expect(this.element).toBeVisible();
		await expect.poll(async () => {
			const lines = await this.lines.allTextContents();
			return accept(lines.join('\n').replace(/\u00a0/g, ' '));
		}, { message: 'editor viewport contents match' }).toBe(true);
	}

	async foldAtLine(line: number): Promise<void> {
		const gutter = this.gutterAtLine(line);
		await gutter.locator('.ash-icon-folding-expanded').click();
		await expect(gutter.locator('.ash-icon-folding-collapsed')).toBeVisible();
	}

	async unfoldAtLine(line: number): Promise<void> {
		const gutter = this.gutterAtLine(line);
		await gutter.locator('.ash-icon-folding-collapsed').click();
		await expect(gutter.locator('.ash-icon-folding-expanded')).toBeVisible();
	}

	private gutterAtLine(line: number): Locator {
		// Model line numbers remain stable when folding changes the visible row order.
		return this.element.locator('.margin-view-overlays > .view-overlay-line').filter({
			has: this.element.page().locator('.line-numbers', { hasText: new RegExp(`^${line}$`) }),
		});
	}
}
