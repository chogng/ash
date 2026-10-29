import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../common/core/range.js';
import { ColorId, StandardTokenType, type ITokenPresentation } from '../../common/encodedTokenAttributes.js';
import { TextDirection } from '../../common/model.js';
import { type IViewLineTokens } from '../../common/tokens/lineTokens.js';
import { InlineDecorationType } from '../../common/viewModel/inlineDecorations.js';
import { LineDecoration } from '../../common/viewLayout/lineDecorations.js';
import { DomPosition, RenderLineInput, renderViewLine2 } from '../../common/viewLayout/viewLineRenderer.js';

const lineTokens: IViewLineTokens = {
	languageIdCodec: { encodeLanguageId: () => 0, decodeLanguageId: () => 'plaintext' },
	equals: other => other === lineTokens,
	getCount: () => 1,
	getStandardTokenType: () => StandardTokenType.Other,
	getForeground: () => ColorId.DefaultForeground,
	getEndOffset: () => 3,
	getClassName: () => '',
	getInlineStyle: () => '',
	getPresentation: (): ITokenPresentation => ({ foreground: ColorId.DefaultForeground, italic: false, bold: false, underline: false, strikethrough: false }),
	findTokenIndexAtOffset: () => 0,
	getLineContent: () => 'a\tb',
	getMetadata: () => 0,
	getLanguageId: () => 'plaintext',
	getTokenText: () => 'a\tb',
	forEach: callback => callback(0),
};

test('line decoration filtering uses one-based Range lines and columns', () => {
	assert.deepEqual(LineDecoration.filter([{
		range: new Range(2, 2, 3, 4),
		inlineClassName: 'detected-link',
		type: InlineDecorationType.Regular,
	}], 3, 1, 10), [
		new LineDecoration(1, 4, 'detected-link', InlineDecorationType.Regular),
	]);
});

test('line renderer maps source columns through decorated spans and tabs', () => {
	const output = renderViewLine2(new RenderLineInput(
		false,
		false,
		'a\tb',
		false,
		true,
		false,
		0,
		lineTokens,
		[new LineDecoration(1, 2, 'token-keyword', InlineDecorationType.Regular)],
		4,
		0,
		8,
		8,
		8,
		-1,
		'none',
		false,
		false,
		null,
		TextDirection.LTR,
		0,
	));

	assert.equal(output.html, '<span class="stanza-editor-line-text"><span class="token-keyword">a</span><span>&nbsp;&nbsp;&nbsp;b</span></span>');
	assert.deepEqual([
		output.characterMapping.getDomPosition(1),
		output.characterMapping.getDomPosition(2),
		output.characterMapping.getDomPosition(3),
		output.characterMapping.getDomPosition(4),
	], [
		new DomPosition(0, 0),
		new DomPosition(1, 0),
		new DomPosition(1, 3),
		new DomPosition(1, 4),
	]);
	assert.deepEqual([1, 2, 3, 4].map(column => output.characterMapping.getHorizontalOffset(column)), [0, 1, 4, 5]);
	assert.equal(output.characterMapping.getColumn(new DomPosition(1, 3), 4), 3);
});
