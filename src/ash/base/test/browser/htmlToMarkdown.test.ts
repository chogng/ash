import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { convertHtmlToMarkdown } from '../../browser/htmlToMarkdown.js';

test('clipboard HTML retains text structure, emphasis, links, lists and tables', () => {
	assert.equal(convertHtmlToMarkdown('<h2>Review</h2><p><strong>Keep</strong> <em>formatting</em> &amp; <a href="https://example.com/a_(b)">docs</a>.</p><ol start="3"><li>first</li><li>second<ul><li>nested</li></ul></li></ol><table><tr><th>File</th></tr><tr><td>a|b</td></tr></table>'),
		'## Review\n\n**Keep** *formatting* & [docs](https://example.com/a_\\(b\\)).\n\n3. first\n4. second\n   \n   - nested\n\n| File |\n| --- |\n| a\\|b |');
});

test('clipboard HTML reduces local links and images to code without redirecting public hrefs', () => {
	assert.equal(convertHtmlToMarkdown('<p><a href="file:///private/a"><strong>A &amp; B</strong></a> <a href="" data-href="https://example.com">Docs</a> <a href="https://real.example" data-href="https://other.example">Real</a> <img src="blob:local" alt="Chart"> <a href="#section">Section</a></p>'),
		'`A & B` [Docs](https://example.com) [Real](https://real.example) `Chart` [Section](#section)');
});

test('clipboard code keeps indentation, blank lines, HTML text and backtick delimiters', () => {
	assert.equal(convertHtmlToMarkdown('<p><code>`&lt;aside&gt;`</code></p><pre><code>  first\n\n\n```\n  last\n</code></pre>'),
		'`` `<aside>` ``\n\n````\n  first\n\n\n```\n  last\n````');
});

test('untrusted clipboard HTML stays inert and excludes hidden and executable content', () => {
	assert.equal(convertHtmlToMarkdown('<p>Visible <a href="javascript:run()">label<script>private</script></a></p><script>run()</script><style>secret</style><iframe>frame</iframe><template>template</template><span hidden>hidden</span><span style="opacity:0">hidden</span><div role="toolbar">controls</div><p>Literal *text*</p>'),
		'Visible `label`\n\nLiteral \\*text\\*');
	assert.equal(convertHtmlToMarkdown('<b>' + 'x'.repeat(200_000) + '</b>'), '');
	assert.doesNotThrow(() => convertHtmlToMarkdown('<span>'.repeat(200) + 'deep' + '</span>'.repeat(200)));
});
