import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Color } from '../../../base/common/color.js';
import { TokenizationRegistry } from '../../common/tokenizationRegistry.js';

test('TokenizationRegistry owns support replacement, delayed creation, and colors', async () => {
	const registry = new TokenizationRegistry<object>();
	const changes: Array<{ languages: string[]; colors: boolean }> = [];
	using listener = registry.onDidChange(event => changes.push({ languages: event.changedLanguages, colors: event.changedColorMap }));
	const first = {};
	const second = {};
	using firstRegistration = registry.register('stanza', first);
	using secondRegistration = registry.register('stanza', second);
	firstRegistration.dispose();
	assert.equal(registry.get('stanza'), second);

	let created = 0;
	using factory = registry.registerFactory('paper', {
		get tokenizationSupport() {
			created += 1;
			return Promise.resolve({ dispose() {}, [Symbol.dispose]() { this.dispose(); } });
		},
	});
	assert.equal(registry.isResolved('paper'), false);
	assert.ok(await registry.getOrCreate('paper'));
	assert.equal(created, 1);
	assert.equal(registry.isResolved('paper'), true);

	const colors = [Color.fromHex('#000000'), Color.fromHex('#ffffff'), Color.fromHex('#101010')];
	registry.setColorMap(colors);
	assert.deepEqual(registry.getColorMap(), colors);
	assert.equal(changes.at(-1)?.colors, true);
});
