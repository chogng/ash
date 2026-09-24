import assert from 'node:assert/strict';
import { test } from 'mocha';
import { OffsetRange } from '../../../common/core/ranges/offsetRange.js';
import { LanguageId, MetadataConsts } from '../../../common/encodedTokenAttributes.js';
import { type ILanguageIdCodec } from '../../../common/languages.js';
import { type IViewLineTokens, LineTokens, TokenArray, TokenArrayBuilder, TokenInfo } from '../../../common/tokens/lineTokens.js';

interface ILineToken {
	readonly startIndex: number;
	readonly foreground: number;
}

const languageIdCodec: ILanguageIdCodec = {
	encodeLanguageId: languageId => languageId === 'typescript' ? 2 as LanguageId : LanguageId.PlainText,
	decodeLanguageId: languageId => languageId === (2 as LanguageId) ? 'typescript' : 'plaintext',
};

function createLineTokens(text: string, tokens: readonly ILineToken[]): LineTokens {
	const binaryTokens = new Uint32Array(tokens.length << 1);
	for (let index = 0; index < tokens.length; index++) {
		binaryTokens[index << 1] = index + 1 < tokens.length ? tokens[index + 1].startIndex : text.length;
		binaryTokens[(index << 1) + 1] = (tokens[index].foreground << MetadataConsts.FOREGROUND_OFFSET) >>> 0;
	}
	return new LineTokens(binaryTokens, text, languageIdCodec);
}

function createTestLineTokens(): LineTokens {
	return createLineTokens('Hello world, this is a lovely day', [
		{ startIndex: 0, foreground: 1 },
		{ startIndex: 6, foreground: 2 },
		{ startIndex: 13, foreground: 3 },
		{ startIndex: 18, foreground: 4 },
		{ startIndex: 21, foreground: 5 },
		{ startIndex: 23, foreground: 6 },
		{ startIndex: 30, foreground: 7 },
	]);
}

function renderLineTokens(tokens: LineTokens): string {
	let result = '';
	let lastOffset = 0;
	for (let index = 0; index < tokens.getCount(); index++) {
		result += tokens.getLineContent().substring(lastOffset, tokens.getEndOffset(index));
		result += `(${tokens.getMetadata(index)})`;
		lastOffset = tokens.getEndOffset(index);
	}
	return result;
}

function viewTokenSummary(tokens: IViewLineTokens): readonly { readonly endIndex: number; readonly foreground: number; readonly text: string }[] {
	return Array.from({ length: tokens.getCount() }, (_, index) => ({
		endIndex: tokens.getEndOffset(index),
		foreground: tokens.getForeground(index),
		text: tokens.getTokenText(index),
	}));
}

test('LineTokens inserts tokens at boundaries and inside existing tokens', () => {
	const lineTokens = createTestLineTokens();
	assert.equal(renderLineTokens(lineTokens), 'Hello (32768)world, (65536)this (98304)is (131072)a (163840)lovely (196608)day(229376)');

	assert.equal(renderLineTokens(lineTokens.withInserted([
		{ offset: 0, text: '1', tokenMetadata: 0 },
		{ offset: 6, text: '2', tokenMetadata: 0 },
		{ offset: 9, text: '3', tokenMetadata: 0 },
	])), '1(0)Hello (32768)2(0)wor(65536)3(0)ld, (65536)this (98304)is (131072)a (163840)lovely (196608)day(229376)');

	assert.equal(renderLineTokens(lineTokens.withInserted([
		{ offset: 0, text: '1', tokenMetadata: 0 },
		{ offset: 0, text: '2', tokenMetadata: 0 },
		{ offset: 0, text: '3', tokenMetadata: 0 },
	])), '1(0)2(0)3(0)Hello (32768)world, (65536)this (98304)is (131072)a (163840)lovely (196608)day(229376)');

	assert.equal(renderLineTokens(lineTokens.withInserted([
		{ offset: 32, text: '1', tokenMetadata: 0 },
		{ offset: 33, text: '2', tokenMetadata: 0 },
	])), 'Hello (32768)world, (65536)this (98304)is (131072)a (163840)lovely (196608)da(229376)1(0)y(229376)2(0)');
});

test('LineTokens exposes offsets and finds the token containing each boundary', () => {
	const lineTokens = createTestLineTokens();
	assert.equal(lineTokens.getLineContent(), 'Hello world, this is a lovely day');
	assert.equal(lineTokens.getTextLength(), 33);
	assert.equal(lineTokens.getCount(), 7);
	assert.deepEqual(Array.from({ length: 7 }, (_, index) => [lineTokens.getStartOffset(index), lineTokens.getEndOffset(index)]), [
		[0, 6],
		[6, 13],
		[13, 18],
		[18, 21],
		[21, 23],
		[23, 30],
		[30, 33],
	]);
	assert.deepEqual(Array.from({ length: 35 }, (_, offset) => lineTokens.findTokenIndexAtOffset(offset)), [
		0, 0, 0, 0, 0, 0,
		1, 1, 1, 1, 1, 1, 1,
		2, 2, 2, 2, 2,
		3, 3, 3,
		4, 4,
		5, 5, 5, 5, 5, 5, 5,
		6, 6, 6, 6, 6,
	]);
});

test('LineTokens slices preserve token metadata, clipped text, and delta offsets', () => {
	const lineTokens = createTestLineTokens();
	assert.equal(lineTokens.inflate(), lineTokens);
	assert.deepEqual(viewTokenSummary(lineTokens.sliceAndInflate(0, 32, 0)), [
		{ endIndex: 6, foreground: 1, text: 'Hello ' },
		{ endIndex: 13, foreground: 2, text: 'world, ' },
		{ endIndex: 18, foreground: 3, text: 'this ' },
		{ endIndex: 21, foreground: 4, text: 'is ' },
		{ endIndex: 23, foreground: 5, text: 'a ' },
		{ endIndex: 30, foreground: 6, text: 'lovely ' },
		{ endIndex: 32, foreground: 7, text: 'da' },
	]);
	assert.deepEqual(viewTokenSummary(lineTokens.sliceAndInflate(7, 19, 1)), [
		{ endIndex: 7, foreground: 2, text: 'orld, ' },
		{ endIndex: 12, foreground: 3, text: 'this ' },
		{ endIndex: 13, foreground: 4, text: 'i' },
	]);
	assert.deepEqual(viewTokenSummary(lineTokens.sliceZeroCopy(new OffsetRange(6, 18))), [
		{ endIndex: 7, foreground: 2, text: 'world, ' },
		{ endIndex: 12, foreground: 3, text: 'this ' },
	]);
});

test('LineTokens factories and metadata access preserve text and language identity', () => {
	const metadata = (2 << MetadataConsts.LANGUAGEID_OFFSET) | (4 << MetadataConsts.FOREGROUND_OFFSET);
	const lineTokens = LineTokens.createFromTextAndMetadata([
		{ text: 'const ', metadata },
		{ text: 'value', metadata: 0 },
	], languageIdCodec);
	assert.equal(lineTokens.getLanguageId(0), 'typescript');
	assert.equal(lineTokens.getForeground(0), 4);
	assert.equal(lineTokens.getTokenText(0), 'const ');
	assert.equal(lineTokens.toString(), '[const ]{mtk4}[value]{mtk0}');
	assert.equal(LineTokens.createEmpty('plain', languageIdCodec).getMetadata(0), LineTokens.defaultTokenMetadata);

	const startOffsets = new Uint32Array([0, metadata, 6, 0]);
	LineTokens.convertToEndOffset(startOffsets, 11);
	assert.deepEqual([...startOffsets], [6, metadata, 11, 0]);
	assert.equal(lineTokens.equals(LineTokens.createFromTextAndMetadata([
		{ text: 'const ', metadata },
		{ text: 'value', metadata: 0 },
	], languageIdCodec)), true);
});

test('TokenArray slices, appends, and converts without changing metadata spans', () => {
	const builder = new TokenArrayBuilder();
	builder.add(3, 10);
	builder.add(4, 20);
	const tokens = builder.build();
	assert.deepEqual(tokens.map((range, token) => [range.start, range.endExclusive, token.metadata]), [[0, 3, 10], [3, 7, 20]]);
	assert.deepEqual(tokens.slice(new OffsetRange(2, 5)).map((range, token) => [range.length, token.metadata]), [[1, 10], [2, 20]]);

	const appended = tokens.append(TokenArray.create([new TokenInfo(2, 30)]));
	const lineTokens = appended.toLineTokens('abcdefghi', languageIdCodec);
	assert.deepEqual(viewTokenSummary(lineTokens), [
		{ endIndex: 3, foreground: 0, text: 'abc' },
		{ endIndex: 7, foreground: 0, text: 'defg' },
		{ endIndex: 9, foreground: 0, text: 'hi' },
	]);
	assert.deepEqual(TokenArray.fromLineTokens(lineTokens).map((range, token) => [range.length, token.metadata]), [[3, 10], [4, 20], [2, 30]]);
});
