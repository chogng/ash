import assert from 'node:assert/strict';
import { test } from 'mocha';
import { computeLinks } from '../../../common/languages/linkComputer.js';
import { Range } from '../../../common/core/range.js';
import { TextModel } from '../../../common/model/textModel.js';
import { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import type { LanguageLinkProvider } from '../../../common/languages.js';
import { LinkService } from '../../../contrib/links/common/languageLinks.js';

test('link detection preserves URL punctuation and excludes surrounding prose', () => {
	using model = new TextModel('😀 (https://example.test/a_(b)).\nfile:///tmp/demo.txt; https://[::1]:8080/a?q=1&b=2\n“https://example.test/你好” javascript:alert(1) https://');
	const links = computeLinks(model);
	assert.deepEqual(links.map(link => [link.url, model.getValueInRange(link.range)]), [
		['https://example.test/a_(b)', 'https://example.test/a_(b)'],
		['file:///tmp/demo.txt', 'file:///tmp/demo.txt'],
		['https://[::1]:8080/a?q=1&b=2', 'https://[::1]:8080/a?q=1&b=2'],
		['https://example.test/你好', 'https://example.test/你好'],
	]);
	assert.deepEqual(links[0]!.range, new Range(1, 5, 1, 31));
	assert.deepEqual(computeLinks(null), []);
});

test('link requests combine detected URLs with provider links without duplicate ranges', async () => {
	using model = new TextModel('https://one.test https://two.test');
	const providers = new LanguageFeatureRegistry<LanguageLinkProvider>();
	using registration = providers.register('*', {
		provideLinks: () => [{ range: new Range(1, 1, 1, 17), target: 'https://resolved.test', tooltip: 'Provider link' }],
	});
	using service = new LinkService(model, providers);
	assert.deepEqual((await service.provideLinks('plaintext')).map(link => [link.target, link.tooltip]), [
		['https://resolved.test', 'Provider link'],
		['https://two.test', undefined],
	]);
});

test('link requests reject canceled and stale provider results before scanning the current document', async () => {
	using model = new TextModel('https://one.test');
	const providers = new LanguageFeatureRegistry<LanguageLinkProvider>();
	let finish!: () => void;
	using registration = providers.register('*', {
		provideLinks: () => new Promise(resolve => { finish = () => resolve([]); }),
	});
	using service = new LinkService(model, providers);
	const pending = service.provideLinks('plaintext');
	model.applyEdits([{ range: new Range(1, 1, 1, 17), text: 'https://two.test' }]);
	finish();
	assert.deepEqual(await pending, []);
	const cancellation = new AbortController();
	cancellation.abort();
	assert.deepEqual(await service.provideLinks('plaintext', cancellation.signal), []);
});
