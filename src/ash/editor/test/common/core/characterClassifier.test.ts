import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CharacterClassifier } from '../../../common/core/characterClassifier.js';

test('Character classification preserves explicit zero values across ASCII and Unicode', () => {
	const classifier = new CharacterClassifier<number>(10);
	const characters = [65, 256, 0x4e00, 0x1f600];
	assert.deepEqual(characters.map(character => classifier.get(character)), [10, 10, 10, 10]);
	for (const character of characters) classifier.set(character, 0);
	assert.deepEqual(characters.map(character => classifier.get(character)), [0, 0, 0, 0]);
	classifier.set(0x4e00, 3);
	assert.equal(classifier.get(0x4e00), 3);
	classifier.clear();
	assert.deepEqual(characters.map(character => classifier.get(character)), [10, 10, 10, 10]);
});
