import assert from 'node:assert/strict';
import { test } from 'mocha';
import { type IRegistry, Registry } from '../../common/platform.js';

test('platform registry exposes add, knows, and as', () => {
	assert.equal(typeof Registry.add, 'function');
	assert.equal(typeof Registry.knows, 'function');
	assert.equal(typeof Registry.as, 'function');

	const contribution = { enabled: true };
	Registry.add('test.platform.registry.api', contribution);

	assert.equal(Registry.knows('test.platform.registry.api'), true);
	assert.equal(Registry.knows('test.platform.registry.missing'), false);
	assert.equal(Registry.as('test.platform.registry.api'), contribution);
	assert.equal(Registry.as('test.platform.registry.missing'), null);
	assert.throws(
		() => Registry.add('test.platform.registry.api', { enabled: false }),
		/There is already an extension with this id/u,
	);
});

test('platform registry disposes registered contributions and clears itself', () => {
	interface DisposableRegistry extends IRegistry {
		dispose(): void;
	}

	const RegistryConstructor = Object.getPrototypeOf(Registry).constructor as new () => DisposableRegistry;
	const registry = new RegistryConstructor();
	let disposeCount = 0;
	registry.add('test.platform.registry.disposable', {
		dispose(): void {
			disposeCount += 1;
		},
	});
	registry.add('test.platform.registry.value', { value: true });

	registry.dispose();

	assert.equal(disposeCount, 1);
	assert.equal(registry.knows('test.platform.registry.disposable'), false);
	assert.equal(registry.knows('test.platform.registry.value'), false);
	assert.equal(registry.as('test.platform.registry.disposable'), null);
	registry.dispose();
	assert.equal(disposeCount, 1);
});
