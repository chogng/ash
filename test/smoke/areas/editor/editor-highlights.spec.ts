import { expect, test } from '../../../automation/test.js';

test('symbol highlight backgrounds align with their text in the workbench editor', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('use crate::UserAllowlist;');
	await page.keyboard.press('Enter');
	await editor.waitForTypeInEditor('    user_allowlist: UserAllowlist,');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	await expect(editor.element.locator('.cdr.word-highlight-text')).toHaveCount(2);
	await expect.poll(() => editor.element.evaluate(root => {
		return [...root.querySelectorAll<HTMLElement>('.cdr.word-highlight-text')].map(highlight => {
			const lineIndex = highlight.parentElement!.dataset.lineIndex;
			const text = root.querySelector(`.view-lines > .view-line[data-line-index="${lineIndex}"] > .stanza-editor-line-text`)!;
			const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
			let symbol: DOMRect | undefined;
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const start = node.textContent!.indexOf('UserAllowlist');
				if (start < 0) continue;
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, start + 'UserAllowlist'.length);
				symbol = range.getBoundingClientRect();
				break;
			}
			const background = highlight.getBoundingClientRect();
			return { lineIndex, aligned: symbol !== undefined && Math.abs(background.left - symbol.left) < 1 && Math.abs(background.right - symbol.right) < 1 };
		});
	})).toEqual([{ lineIndex: '0', aligned: true }, { lineIndex: '1', aligned: true }]);
});
