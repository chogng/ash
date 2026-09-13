import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Color } from '../../common/color.js';

test("Color parses, normalizes, and composes immutable RGBA values", () => {
	assert.equal(Color.fromHex("#fff").toString(), "#ffffff");
	assert.equal(Color.fromHex('#33669980').toString(), 'rgba(51, 102, 153, 0.5)');
	assert.equal(Color.fromHex('#ff0000').transparent(0.5).toString(), 'rgba(255, 0, 0, 0.5)');
	assert.equal(Color.fromHex("#000000").lighten(0.5).toString(), "#000000");
	assert.equal(Color.fromHex("#ffffff").darken(0.5).toString(), "#808080");
	assert.equal(Color.fromHex("#ffffff80").makeOpaque(Color.fromHex("#000000")).toString(), "#808080");
});

test('Color uses red for malformed hexadecimal values', () => {
	assert.equal(Color.fromHex('red').toString(), '#ff0000');
	assert.equal(Color.fromHex('#12').toString(), '#ff0000');
});
