import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { testUrlMatchesGlob } from '../../common/urlGlob.js';

suite('URL opener patterns', () => {
	const cases: readonly [string, string, boolean][] = [
		['https://docs.example.test/guide/?lang=zh#topic', 'docs.example.test/guide', true],
		['http://docs.example.test/guide', 'https://docs.example.test/guide', false],
		['mailto:user@example.test', '*', false],
		['https://example.test', '*', true],
		['https://a.b.example.test/api/item', '*.example.test/api/*', true],
		['https://example.test/api/item', '*.example.test/api/*', true],
		['https://otherexample.test/api/item', '*.example.test/api/*', false],
		['https://example.test:8080/api', 'example.test:*/api', true],
		['https://example.test/api', 'example.test:*/api', true],
		['https://example.test:8080/api', 'example.test:9090/api', false],
		['https://example.test/api', 'example.test:8080/api', false],
		['https://example.test/docs/child', 'example.test/docs', true],
		['https://example.test/docs-old', 'example.test/docs', false],
		['https://example.test/anything', 'example.test/', true],
		['https://example.test/ab', 'example.test/a*', true],
		['https://example.test/a', 'example.test/a*', false],
		['https://example.test/docs/x/item', 'example.test/docs/*/item', true],
		['https://example.test/docs/x/miss', 'example.test/docs/*/item', false],
		['https://example.test/docs/../outside', 'example.test/docs', false],
		['https://example.test/docs/%2e%2e/outside', 'example.test/docs', false],
		['https://example.test/docs/sub/../inside', 'example.test/docs', true],
		['https://example.test/outside', 'example.test/docs/../outside', false],
		['https://例子.test/docs', '*.xn--fsqu00a.test/docs', true],
		['https://xn--fsqu00a.test/docs', '*.例子.test/docs', true],
		['https://EXAMPLE.test/docs', 'example.test/docs', true],
		['https://example.test/Docs', 'example.test/docs', false],
		['https://example.test/docs/%61', 'example.test/docs/a', true],
		['https://example.test/docs/a%2Fb', 'example.test/docs/a/b', false],
		['https://example.test/docs/a%23b', 'example.test/docs/a%23b', true],
		['https://example.test/docs/%E4%BD%A0', 'example.test/docs/你', true],
		['https://[::1]:8080/docs', 'https://[::1]:*/docs', true],
		['https://example.test\\@other.test/docs', 'other.test', false],
	];
	for (const [url, pattern, expected] of cases) {
		test(`${pattern} matches ${url}: ${expected}`, () => {
			assert.equal(testUrlMatchesGlob(url, pattern), expected);
			assert.equal(testUrlMatchesGlob(URI.parse(url), pattern), expected);
		});
	}
	test('long paths do not require recursive matching', () => {
		const url = `https://example.test/docs/${'x'.repeat(16_384)}/end`;
		assert.deepEqual(['example.test/docs/*/end', 'example.test/docs/*/absent'].map(pattern => testUrlMatchesGlob(url, pattern)), [true, false]);
	});
});
