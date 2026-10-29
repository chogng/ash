import { registerTestCodeEditorFeatures } from '../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import './testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { TextModel } from '../../common/model/textModel.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import { LinkDetector } from '../../contrib/links/browser/links.js';
import { createTestCodeEditor } from './testCodeEditor.js';

async function waitFor(predicate: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > end) throw new Error('Link detector did not reach the expected current result');
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
}

test('detected links preserve adjacent provider precedence and update edited rows and newline shifts', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using close = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('https://a.test https://b.test\nplain\nhttps://c.test');
	using features = new LanguageFeaturesService();
	using provider = features.linkProvider.register('*', {
		provideLinks: () => [
			{ range: new Range(1, 1, 1, 16), target: 'custom:first' },
			{ range: new Range(1, 20, 1, 24), target: 'custom:second' },
		],
	});
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		languageFeaturesService: features,
	});
	const detector = LinkDetector.get(editor)!;
	await waitFor(() => detector.getLinkOccurrence(new Position(3, 3))?.target === 'https://c.test');
	assert.equal(detector.getLinkOccurrence(new Position(1, 3))?.target, 'custom:first');
	assert.equal(detector.getLinkOccurrence(new Position(1, 21))?.target, 'custom:second');
	assert.equal(detector.getLinkOccurrence(new Position(1, 17)), null);
	provider.dispose();
	await waitFor(() => detector.getLinkOccurrence(new Position(1, 17))?.target === 'https://b.test');
	model.applyOperations([{ range: new Range(3, 9, 3, 10), text: 'changed' }]);
	await waitFor(() => detector.getLinkOccurrence(new Position(3, 3))?.target === 'https://changed.test');
	model.applyOperations([{ range: new Range(1, 1, 1, 1), text: '\n' }]);
	await waitFor(() => detector.getLinkOccurrence(new Position(4, 3))?.target === 'https://changed.test');
	await model.undo();
	await waitFor(() => detector.getLinkOccurrence(new Position(3, 3))?.target === 'https://changed.test');
});

test('an edit during a multi-batch link scan cancels its old coordinates and preserves every current link', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using close = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('https://first.test\n' + 'plain\n'.repeat(20_000) + 'https://last.test');
	const errors: unknown[] = [];
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		onLanguageError: error => errors.push(error),
	});
	const detector = LinkDetector.get(editor)!;
	const edit = setTimeout(() => model.applyOperations([{ range: new Range(1, 1, 1, 1), text: 'prefix\n' }]), 0);
	try {
		await waitFor(() => detector.getLinkOccurrence(new Position(20_003, 3))?.target === 'https://last.test');
		assert.equal(detector.getLinkOccurrence(new Position(2, 3))?.target, 'https://first.test');
		assert.equal(detector.getLinkOccurrence(new Position(1, 3)), null);
		assert.deepEqual(errors, []);
	} finally {
		clearTimeout(edit);
	}
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
