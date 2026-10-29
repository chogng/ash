import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { getKoreanAltChars } from '../../../common/naturalLanguage/korean.js';

function keyboardInput(text: string): string {
	return Array.from(text, character => {
		const alternative = getKoreanAltChars(character.charCodeAt(0));
		return alternative === undefined ? character : String.fromCharCode(...Array.from(alternative));
	}).join('');
}

suite('Korean keyboard alternatives', () => {
	test('maps modern jamo and compatibility jamo to QWERTY keys', () => {
		assert.equal(keyboardInput('곿 ㄲㅘㄳ'), 'rhkrt Rhkrt');
	});

	test('decomposes syllables with and without a final consonant', () => {
		assert.equal(keyboardInput('가 각 값 괜 힣'), 'rk rkr rkqt rhos glg');
	});

	test('leaves unrelated, filler, and archaic characters without alternatives', () => {
		assert.equal(keyboardInput('A ㅤ ㆍ 😀'), 'A ㅤ ㆍ 😀');
		assert.equal(getKoreanAltChars(0x3164), undefined);
		assert.equal(getKoreanAltChars(0xD7A4), undefined);
	});
});
