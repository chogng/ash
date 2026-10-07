import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { SizeRegistry } from '../../common/sizeRegistry.js';
import { asCssVariableName, size, sizeValueToCss } from '../../common/sizeUtils.js';

const metadata = { description: 'Test token.', owner: 'test' };

test('size registry validates registration and serializes CSS values', () => {
	const registry = new SizeRegistry();
	registry.registerSize('fontSize.body1', size(13), metadata);
	assert.equal(sizeValueToCss(registry.getSizes()[0]!.value), '13px');
	assert.equal(sizeValueToCss(size(400, 'unitless')), '400');
	assert.throws(() => registry.registerSize('fontSize.body1', size(14), metadata), /already registered/);
	assert.throws(() => size(Number.NaN), /must be finite/);
});

test('size contributions remain sealed after startup', () => {
	const sizes = new SizeRegistry();
	sizes.seal();
	assert.throws(() => sizes.registerSize('late.size', size(1), metadata), /registry is sealed/);
});

test('size identifiers use Ash CSS variables', () => {
	assert.equal(asCssVariableName('strokeThickness'), '--ash-stroke-thickness');
});
