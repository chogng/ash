import assert from 'node:assert/strict';
import { test } from 'mocha';
import { attachLanguageTokenResultDelta, getLanguageTokenResultDelta } from '../../common/services/semanticTokensDto.js';
import type { LanguageTokenResult } from '../../common/tokens/languageTokens.js';

test('semantic token DTO attaches immutable validated delta metadata', () => {
	const result: LanguageTokenResult = Object.freeze({ tokens: Object.freeze([]) });
	attachLanguageTokenResultDelta(result, { baseRequestId: 7, splices: Object.freeze([]) });

	assert.deepEqual(getLanguageTokenResultDelta(result), { baseRequestId: 7, splices: [] });
	assert.equal(Object.isFrozen(getLanguageTokenResultDelta(result)), true);
});

test('semantic token DTO rejects invalid result and splice boundaries', () => {
	const mutable: LanguageTokenResult = { tokens: [] };
	assert.throws(() => attachLanguageTokenResultDelta(mutable, { baseRequestId: 1, splices: [] }), /immutable normalized result/);

	const result: LanguageTokenResult = Object.freeze({ tokens: Object.freeze([]) });
	assert.throws(() => attachLanguageTokenResultDelta(result, {
		baseRequestId: 1,
		splices: [{
			baseStartItemIndex: 0,
			baseDeleteItemCount: 0,
			resultStartItemIndex: 0,
			resultInsertItemCount: 1,
			lineDeltaBefore: 0,
			lineDeltaAfter: 0,
		}],
	}), /inserted items exceed/);
});
