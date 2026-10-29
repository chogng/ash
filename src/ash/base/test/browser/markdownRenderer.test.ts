import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { renderAsPlaintext, renderMarkdown } from '../../browser/markdownRenderer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';
import { ensureNoStylesAreLeakedInTestSuite } from '../../../../../test/unit/documentStyles.js';

suite('Shared Markdown content preservation', () => {
	ensureNoStylesAreLeakedInTestSuite();
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves unsupported HTML as literal text when requested before sanitization', () => {
		const value = '<section><p>Visible content</p></section>';
		using omitted = renderMarkdown({ value });
		using retained = renderMarkdown({ value }, { sanitizerConfig: { replaceWithPlaintext: true } });
		assert.equal(omitted.element.textContent, '');
		assert.equal(retained.element.textContent?.trim(), value);
		assert.equal(retained.element.querySelector('section'), null);
	});

	test('standard HTML tables and disclosure content use the shared sanitizer', () => {
		using result = renderMarkdown({
			value: '<details onclick="globalThis.auditXss = true"><summary>Details</summary><table><tr><td>Cell</td></tr></table>H<sub>2</sub>O<script>globalThis.auditXss = true</script></details>',
			supportHtml: true,
		});
		assert.equal(result.element.querySelector('summary')?.textContent, 'Details');
		assert.equal(result.element.querySelector('td')?.textContent, 'Cell');
		assert.equal(result.element.querySelector('sub')?.textContent, '2');
		assert.equal(result.element.querySelector('script,[onclick]'), null);
	});

	test('plain text retains HTML block children and image descriptions without executable content', () => {
		const text = renderAsPlaintext(
			'<details><summary>Heading</summary><table><tr><td>Name</td><td>Value</td></tr></table><script>hidden()</script></details>\n\n![Diagram](https://example.com/image)',
		);
		assert.match(text, /Heading\nName\tValue[\s\S]*Diagram/u);
		assert.doesNotMatch(text, /<details|<td|hidden/u);
	});
});
