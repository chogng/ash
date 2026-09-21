import assert from 'node:assert/strict';
import { test } from 'mocha';
import { fixBracketsInLine } from '../../../../common/model/bracketPairsTextModelPart/fixBrackets.js';
import { LineTokens } from '../../../../common/tokens/lineTokens.js';
import { MetadataConsts, StandardTokenType, type LanguageId } from '../../../../common/encodedTokenAttributes.js';
import { type ILanguageIdCodec } from '../../../../common/languages.js';
import { createTestLanguageConfigurationService } from '../../modes/testLanguageConfigurationService.js';

const codec: ILanguageIdCodec = {
	encodeLanguageId: language => (language === 'typescript' ? 1 : 2) as LanguageId,
	decodeLanguageId: id => id === 1 ? 'typescript' : 'embedded',
};

function segment(text: string, type = StandardTokenType.Other, language = 'typescript', balanced = true): { text: string; metadata: number } {
	return { text, metadata: codec.encodeLanguageId(language) | (type << MetadataConsts.TOKEN_TYPE_OFFSET) | (balanced ? MetadataConsts.BALANCED_BRACKETS_MASK : 0) };
}

test('completion bracket repair handles nested missing and unexpected brackets without changing other text', () => {
	using configurations = createTestLanguageConfigurationService();
	for (const [before, after] of [
		['', ''], ['😀 call({x: [1', '😀 call({x: [1]})'], ['a)] + b', 'a + b'],
		['({x: 1)', '({x: 1})'], ['({)}', '({})'], ['({})', '({})'],
		['call(\n[1', 'call(\n[1])'],
	]) {
		assert.equal(fixBracketsInLine(LineTokens.createFromTextAndMetadata([segment(before!)], codec), configurations), after, before);
	}
});

test('completion bracket repair skips strings, comments, regex and excluded scopes', () => {
	using configurations = createTestLanguageConfigurationService();
	const tokens = LineTokens.createFromTextAndMetadata([
		segment('call('), segment('"[)"', StandardTokenType.String), segment(' + '),
		segment('/[(]/', StandardTokenType.RegEx), segment(' /* ) */', StandardTokenType.Comment),
		segment(' custom)', StandardTokenType.Other, 'typescript', false),
	], codec);
	assert.equal(fixBracketsInLine(tokens, configurations), 'call("[)" + /[(]/ /* ) */ custom))');
});

test('completion bracket repair joins styling tokens but keeps embedded language bracket identities', () => {
	using configurations = createTestLanguageConfigurationService();
	using registration = configurations.register('embedded', { brackets: [['begin', 'end'], ['(', ')']] });
	const tokens = LineTokens.createFromTextAndMetadata([
		segment('('), segment('be', StandardTokenType.Other, 'embedded'), segment('gin ', StandardTokenType.Other, 'embedded'),
		segment(')', StandardTokenType.Other, 'embedded'), segment('end', StandardTokenType.Other, 'embedded'), segment(')'),
	], codec);
	assert.equal(fixBracketsInLine(tokens, configurations), '(begin end)');
});

test('completion bracket repair prefers the longest configured bracket at an offset', () => {
	using configurations = createTestLanguageConfigurationService();
	using registration = configurations.register('embedded', { brackets: [['<', '>'], ['<!--', '-->']] });
	const tokens = LineTokens.createFromTextAndMetadata([segment('<!-- text', StandardTokenType.Other, 'embedded')], codec);
	assert.equal(fixBracketsInLine(tokens, configurations), '<!-- text-->');
});
