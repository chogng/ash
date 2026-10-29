import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { isURLDomainTrusted, isURLSafeForTrust, normalizeURLPattern } from '../../common/trustedDomains.js';

suite('Trusted domain rules', () => {
	const cases: readonly [string, readonly string[], boolean][] = [
		['https://docs.example.test/guide?q=untrusted.test#x', ['docs.example.test/guide'], true],
		['https://example.test', [], false],
		['https://example.test', ['*'], true],
		['http://example.test', ['https://example.test'], false],
		['https://a.b.example.test/api', ['*.example.test/api'], true],
		['https://example.test/api', ['*.example.test/api'], true],
		['https://otherexample.test/api', ['*.example.test/api'], false],
		['https://example.test.evil.test/api', ['*.example.test/api'], false],
		['https://example.test:8080/api', ['example.test:*/api'], true],
		['https://example.test/api', ['example.test:*/api'], true],
		['https://example.test:8080/api', ['example.test:9090/api'], false],
		['http://example.test/api', ['example.test:443/api'], false],
		['http://example.test:443/api', ['example.test:443/api'], true],
		['https://example.test/api', ['example.test:443/api'], true],
		['https://example.test/docs/item', ['example.test/docs'], true],
		['https://example.test/docs-old', ['example.test/docs'], false],
		['https://example.test/docs/%2e%2e/outside', ['example.test/docs'], false],
		['https://example.test/docs/%61', ['example.test/docs/a'], true],
		['https://example.test/docs/a%2Fb', ['example.test/docs/a/b'], false],
		['https://EXAMPLE.test/Docs', ['example.test/Docs'], true],
		['https://example.test/Docs', ['example.test/docs'], false],
		['https://例子.test/docs', ['xn--fsqu00a.test/docs'], true],
		['https://xn--fsqu00a.test/docs', ['例子.test/docs'], true],
		['http://localhost:3000', [], true],
		['http://dev.localhost:3000', [], true],
		['http://127.0.0.1:3000', [], true],
		['http://[::1]:3000', [], true],
		['https://localhost.evil.test', [], false],
		['https://example.test\\@evil.test/path', ['evil.test'], false],
		['https://example.test\\@evil.test/path', ['example.test'], true],
		['https://%65xample.test', ['example.test'], true],
		['https://example.test/path%0Ainjected', ['*'], false],
		['mailto:person@example.test', ['*'], false],
	];
	for (const [target, rules, expected] of cases) {
		test(`${target} with ${JSON.stringify(rules)}: ${expected}`, () => {
			const normalized = rules.map(normalizeURLPattern);
			assert.equal(isURLDomainTrusted(URI.parse(target), normalized), expected);
		});
	}
	for (const pattern of ['ftp://example.test', 'example.test@evil.test', 'example.test?q=1', 'example.test#x', 'example.test\\evil.test', 'example.test:65536', 'example.test/docs/../', 'example.test/docs/%2e%2e/', ' example.test', '']) {
		test(`rejects invalid rule ${JSON.stringify(pattern)}`, () => assert.throws(() => normalizeURLPattern(pattern), TypeError));
	}
	test('malformed rules cannot turn a domain comparison into an allow', () => {
		assert.equal(isURLDomainTrusted(URI.parse('https://outside.test'), ['http://[', 'https://outside.test@evil.test']), false);
		assert.equal(isURLSafeForTrust(URI.parse('https://example.test/%00')), false);
		for (const target of ['https://user:secret@example.test', 'https://example.test@evil.test', 'https://[invalid']) {
			assert.throws(() => URI.parse(target), TypeError);
		}
	});
});
