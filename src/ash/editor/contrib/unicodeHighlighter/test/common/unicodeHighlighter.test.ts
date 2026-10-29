import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import { timeout } from '../../../../../base/common/async.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { type UnicodeHighlight } from '../../../../common/services/unicodeTextModelHighlighter.js';
import { type IVersionedEditorWorkerClient } from '../../../../browser/services/editorWorkerService.js';
import { UnicodeHighlighterController } from '../../browser/unicodeHighlighterController.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { findUnicodeHighlights } from '../../common/unicodeHighlights.js';
import { TextModel } from '../../../../common/model/textModel.js';

test('Unicode highlighter finds invisible, bidi, and mixed-script confusable characters', () => {
	using model = new TextModel('const a = 1;\u200b\nconst а = 2;\u202e');
	assert.deepEqual(
		findUnicodeHighlights(model).map(highlight => highlight.kind),
		['invisible', 'confusable', 'bidi'],
	);
});

test('ASCII documents do not start a Unicode worker, while unsafe edits still produce warnings', async () => {
	using model = new TextModel('const safe = true;\n\t// printable ASCII\r\n');
	using decorations = new TextDecorationCollection<UnicodeHighlight>(model);
	let requests = 0;
	const worker: IVersionedEditorWorkerClient = {
		dispose() {},
		[Symbol.dispose]() {
			this.dispose();
		},
		textualSuggest: async () => undefined,
		computeMoreMinimalEdits: async () => undefined,
		navigateValueSet: async () => undefined,
		computeUnicodeHighlights: async () => {
			requests++;
			return findUnicodeHighlights(model);
		},
	};
	const errors: unknown[] = [];
	using controller = new UnicodeHighlighterController(model, decorations, worker, error => errors.push(error));
	// The controller's zero-delay update is queued before this next timer turn.
	await timeout(0);
	assert.equal(requests, 0);
	model.setValue('const value = true;\u200b\u202e');
	await timeout(0);
	assert.equal(requests, 1);
	assert.deepEqual(
		decorations.decorations.map(item => item.metadata.kind),
		['invisible', 'bidi'],
	);
	model.setValue('const safe = false;');
	await timeout(0);
	assert.equal(requests, 1);
	assert.equal(decorations.size, 0);
	model.setValue('const control = "\x01";');
	await timeout(0);
	assert.equal(requests, 2);
	assert.deepEqual(
		decorations.decorations.map(item => item.metadata.kind),
		['invisible'],
	);
	assert.deepEqual(errors, []);
});

test('Unicode controller dispatches the latest synchronous version after attach and cancels on dispose', async () => {
	using model = new TextModel('first');
	using decorations = new TextDecorationCollection<UnicodeHighlight>(model);
	const versions: number[] = [];
	const worker: IVersionedEditorWorkerClient = {
		dispose() {},
		[Symbol.dispose]() {
			this.dispose();
		},
		textualSuggest: async () => undefined,
		computeMoreMinimalEdits: async () => undefined,
		navigateValueSet: async () => undefined,
		computeUnicodeHighlights: async () => {
			versions.push(model.version);
			return findUnicodeHighlights(model);
		},
	};
	const errors: unknown[] = [];
	using controller = new UnicodeHighlighterController(model, decorations, worker, error => errors.push(error));
	assert.deepEqual(versions, []);
	model.setValue('second');
	model.setValue('const a = 1;\u200b');
	await timeout(20);
	assert.deepEqual(versions, [model.version]);
	assert.deepEqual(
		decorations.decorations.map(item => item.metadata.kind),
		['invisible'],
	);
	model.setValue('third');
	controller.dispose();
	await timeout(20);
	assert.equal(versions.length, 1);
	assert.deepEqual(errors, []);
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
