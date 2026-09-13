import assert from 'node:assert/strict';
import { test } from 'mocha';
import { commonPrefixLength, commonSuffixLength, containsRTL, createRegExp, escapeRegExpCharacters, getCharContainingOffset, getLeadingWhitespace, GraphemeIterator, isBasicASCII, isHighSurrogate, isLowSurrogate, splitLines } from '../../common/strings.js';

test('escapeRegExpCharacters turns arbitrary text into a literal pattern', () => {
	const value = 'a.*(b)+[c]?\\d^$|{}';
	assert.equal(new RegExp(`^${escapeRegExpCharacters(value)}$`, 'u').test(value), true);
});

test('createRegExp and getLeadingWhitespace preserve editor search boundaries', () => {
	const expression = createRegExp('word', false, { wholeWord: true, global: true });
	assert.deepEqual([...('word sword word').matchAll(expression)].map(match => match.index), [0, 11]);
	assert.equal(getLeadingWhitespace('x\t  value', 1), '\t  ');
});

test('ASCII and line helpers share editor text boundary semantics', () => {
	assert.deepEqual({
		plain: isBasicASCII('plain\ttext'),
		control: isBasicASCII('\u0000'),
		unicode: isBasicASCII('你好'),
		lines: splitLines('first\rsecond\r\nthird\nfourth'),
	}, {
		plain: true,
		control: false,
		unicode: false,
		lines: ['first', 'second', 'third', 'fourth'],
	});
});

test('string common lengths use UTF-16 code-unit identity', () => {
	assert.equal(commonPrefixLength('prefix-left', 'prefix-right'), 7);
	assert.equal(commonSuffixLength('left-suffix', 'right-suffix'), 8);
	assert.equal(commonPrefixLength('', 'value'), 0);
	assert.equal(commonSuffixLength('value', ''), 0);
});

test('Unicode helpers preserve surrogate and grapheme boundaries', () => {
	const value = 'A\u{1F469}\u200D\u{1F527}B';
	const iterator = new GraphemeIterator(value);
	const lengths: number[] = [];
	while (!iterator.eol()) lengths.push(iterator.nextGraphemeLength());

	assert.deepEqual(lengths, [1, 5, 1]);
	assert.deepEqual(getCharContainingOffset(value, 2), [1, 6]);
	assert.deepEqual(getCharContainingOffset(value, value.length), [7, 7]);
	assert.equal(isHighSurrogate('\u{1F680}'.charCodeAt(0)), true);
	assert.equal(isLowSurrogate('\u{1F680}'.charCodeAt(1)), true);
	assert.equal(containsRTL('plain text'), false);
	assert.equal(containsRTL('English \u05D1\u05D3\u05D9\u05E7\u05D4'), true);
});
