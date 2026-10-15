import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

// Resolve through the product's consumer so this checks the renderer actually bundled by Ash.
const extensionRequire = createRequire(resolve(import.meta.dirname, '../../extensions/markdown-language-features/package.json'));
const katex = extensionRequire('katex');

test('Markdown math does not inherit permission to load external resources from renderer options', () => {
	const formula = String.raw`\includegraphics{https://audit-image.invalid/pixel}`;
	const inherited = Object.assign(Object.create({ trust: true }), { throwOnError: false });
	assert.doesNotMatch(katex.renderToString(formula, inherited), /<img\b/u);
	assert.doesNotMatch(katex.renderToString(formula, { throwOnError: false }), /<img\b/u);
	// An explicitly trusted caller still has the documented opt-in; the regression is inheritance.
	assert.match(katex.renderToString(formula, { trust: true }), /<img\b/u);
});

test('Markdown math keeps inline, display, matrix and invalid-expression rendering', () => {
	for (const formula of [String.raw`E=mc^2`, String.raw`\frac{a}{b}`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`]) {
		assert.match(katex.renderToString(formula), /class="katex"/u);
	}
	assert.match(katex.renderToString(String.raw`\sum_{i=1}^{n} i`, { displayMode: true }), /class="katex-display"/u);
	assert.match(katex.renderToString(String.raw`\unknownAuditCommand`, { throwOnError: false }), /#cc0000|katex-error/u);
});
