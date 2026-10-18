import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { buildReplaceStringWithCasePreserved } from '../../common/search.js';

suite('Case-preserving replacement', () => {
	test('uses the full match and leaves absent matches and empty replacements unchanged', () => {
		assert.equal(buildReplaceStringWithCasePreserved(null, 'NewValue'), 'NewValue');
		assert.equal(buildReplaceStringWithCasePreserved([], 'NewValue'), 'NewValue');
		assert.equal(buildReplaceStringWithCasePreserved([''], 'NewValue'), 'NewValue');
		assert.equal(buildReplaceStringWithCasePreserved(['VALUE', 'lower'], 'NewValue'), 'NEWVALUE');
		assert.equal(buildReplaceStringWithCasePreserved(['value', 'UPPER'], 'NewValue'), 'newvalue');
		assert.equal(buildReplaceStringWithCasePreserved(['Value'], ''), '');
	});

	test('preserves replacement interiors for mixed case and uncased initials', () => {
		assert.equal(buildReplaceStringWithCasePreserved(['Title'], 'newValue'), 'NewValue');
		assert.equal(buildReplaceStringWithCasePreserved(['tItLe'], 'NewValue'), 'newValue');
		assert.equal(buildReplaceStringWithCasePreserved(['TiTle'], 'newValue'), 'NewValue');
		assert.equal(buildReplaceStringWithCasePreserved(['1tItLe'], 'NewValue'), 'NewValue');
		assert.equal(buildReplaceStringWithCasePreserved(['ÉTÉ'], 'été'), 'ÉTÉ');
	});

	test('preserves casing per corresponding hyphen or underscore word', () => {
		assert.equal(buildReplaceStringWithCasePreserved(['api-CLIENT-Name'], 'new-server-label'), 'new-SERVER-Label');
		assert.equal(buildReplaceStringWithCasePreserved(['API_client_Name'], 'new_server_label'), 'NEW_server_Label');
		assert.equal(buildReplaceStringWithCasePreserved(['-Name--API-'], '-label--url-'), '-Label--URL-');
		assert.equal(buildReplaceStringWithCasePreserved(['Api-CLIENT'], 'new-server-extra'), 'New-server-extra');
		assert.equal(buildReplaceStringWithCasePreserved(['Api_CLIENT-Name'], 'new_server-label'), 'New_server-label');
	});
});
