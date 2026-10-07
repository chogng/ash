import assert from 'node:assert/strict';
import { test } from 'mocha';
import { isCompletionsEnabledFromObject, isCompletionsEnablement } from '../../common/services/completionsEnablement.js';

test('completion enablement resolves language overrides before the wildcard', () => {
	assert.equal(isCompletionsEnabledFromObject({ '*': true, markdown: false }, 'markdown'), false);
	assert.equal(isCompletionsEnabledFromObject({ '*': false, typescript: true }, 'typescript'), true);
	assert.equal(isCompletionsEnabledFromObject({ '*': true }, 'rust'), true);
	assert.equal(isCompletionsEnabledFromObject({}, 'rust'), false);
	assert.equal(isCompletionsEnabledFromObject(Object.create({ '*': true }) as Record<string, boolean>, 'rust'), false);
});

test('completion enablement accepts booleans and rejects malformed maps', () => {
	assert.equal(isCompletionsEnabledFromObject(true, 'rust'), true);
	assert.equal(isCompletionsEnabledFromObject(false, 'rust'), false);
	assert.equal(isCompletionsEnabledFromObject(undefined, 'rust'), false);
	assert.equal(isCompletionsEnablement({ '*': true, rust: false }), true);
	assert.equal(isCompletionsEnablement({ '*': 'yes' }), false);
	assert.equal(isCompletionsEnablement([]), false);
});
