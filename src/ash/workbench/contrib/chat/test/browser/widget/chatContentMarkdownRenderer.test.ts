import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ChatContentMarkdownRenderer } from '../../../browser/widget/chatContentMarkdownRenderer.js';

function services(): InstantiationService {
	const instance = new InstantiationService(new ServiceCollection([IOpenerService, { open: async () => true } as unknown as IOpenerService]));
	instance.registerInstance(IMarkdownRendererService, instance.createInstance(MarkdownRendererService));
	return instance;
}

suite('Shared chat Markdown rendering', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the service code renderer and retains safe HTML and formulas in one result', async () => {
		using scope = services();
		let completed!: () => void;
		const pending = new Promise<void>(resolve => { completed = resolve; });
		scope.get(IMarkdownRendererService).setDefaultCodeBlockRenderer({
			renderCodeBlock: async (_language, text) => {
				const code = document.createElement('code'); code.textContent = `highlighted ${text}`; return code;
			}
		});
		using result = scope.createInstance(ChatContentMarkdownRenderer).render({ value: '<details><summary>Details</summary>Retained</details>\n\n$$\\frac{a}{b}+\\sqrt{x}$$\n\n```ts\nconst value = 1;\n```', supportHtml: true }, { asyncRenderCallback: completed });
		await pending;
		assert.equal(result.element.querySelector('summary')?.textContent, 'Details');
		assert.ok(result.element.querySelector('math mfrac'));
		assert.equal(result.element.querySelector('.ash-katex-container')?.getAttribute('data-latex'), '\\frac{a}{b}+\\sqrt{x}');
		assert.match(result.element.querySelector('pre')?.textContent ?? '', /highlighted const value = 1;/u);
	});

	test('retains blocked media descriptions without provider URLs or duplicate network policy', () => {
		using scope = services();
		using result = scope.createInstance(ChatContentMarkdownRenderer).render({ value: '![Diagram](https://example.com/image)\n\n<video src="https://example.com/movie" title="Demo"/>', supportHtml: true }, { sanitizerConfig: { replaceWithPlaintext: false } });
		assert.equal(result.element.querySelector('img[src],video[src]'), null);
		assert.deepEqual(Array.from(result.element.querySelectorAll('.ash-chat-markdown-media'), item => item.textContent), ['Diagram', 'Demo']);
		assert.doesNotMatch(result.element.innerHTML, /chatgpt|https:\/\/example/u);
	});

	test('does not render code examples or currency as math, and retains invalid formulas', () => {
		using scope = services();
		using result = scope.createInstance(ChatContentMarkdownRenderer).render({ value: '`$x$`\n\n```latex\n$$x$$\n```\n\ncost$x$word and $("#id")\n\n$\\notAFormula{x}$\n\n\\(x+1\\)' });
		assert.equal(result.element.querySelectorAll('.ash-katex-container').length, 1);
		assert.equal(result.element.querySelector('code')?.textContent, '$x$');
		assert.match(result.element.textContent ?? '', /cost\$x\$word[\s\S]*\$\\notAFormula\{x\}\$/u);
	});

	test('sanitizes formula markup, links and inline styles without expanding trust', () => {
		using scope = services();
		using result = scope.createInstance(ChatContentMarkdownRenderer).render({ value: '$\\href{javascript:alert(1)}{unsafe}$\n\n<span onclick="alert(1)" style="position:fixed;background:url(https://example.com/tracker);color:red">Visible</span>', supportHtml: true }, { sanitizerConfig: { replaceWithPlaintext: false } });
		assert.equal(result.element.querySelector('[onclick],script,a[href^="javascript:"]'), null);
		assert.match(result.element.textContent ?? '', /Visible/u);
		assert.doesNotMatch(result.element.querySelector('span[style]')?.getAttribute('style') ?? '', /fixed|url\(/u);
	});
});
