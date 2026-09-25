import { MarkdownElement } from '../../../src/ash/base/browser/markdownRenderer.js';

const markdown = 'a<em>b</em>c and `<span>code</span>`\n\n- [x] Done\n\n[Open](https://example.com)';
const plain = new MarkdownElement({ ownerDocument: document, markdown });
const supported = new MarkdownElement({
	ownerDocument: document,
	markdown: { value: markdown, supportHtml: true },
});

document.getElementById('default')!.append(plain.element);
document.getElementById('html-supported')!.append(supported.element);

declare global {
	interface Window {
		ashMarkdownIntegration: { dispose(): void };
	}
}

window.ashMarkdownIntegration = {
	dispose(): void {
		plain.dispose();
		supported.dispose();
	},
};
