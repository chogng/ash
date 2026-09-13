import assert from 'node:assert/strict';
import { test } from 'mocha';
import { enableHotReload } from '../../../../base/common/hotReload.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier, IInstantiationService, ServiceContainer } from '../../../instantiation/common/instantiation.js';
import { wrapInReloadableClass1 } from '../../common/wrapInReloadableClass.js';

type HotReloadGlobal = typeof globalThis & {
	$hotReload_applyNewExports?: (request: { readonly oldExports: Record<string, unknown>; readonly newSrc: string }) => ((newExports: Record<string, unknown>) => boolean) | undefined;
};

test('wrapInReloadableClass1 keeps one caller argument and resolves services for every instance', () => {
	const events: string[] = [];
	interface TestService {
		readonly instance: number;
	}
	const ITestService = createServiceIdentifier<TestService>('testService');
	const instantiationService = new ServiceContainer();
	let serviceInstance = 0;
	instantiationService.registerTransient(ITestService, () => ({ instance: ++serviceInstance }));

	let CurrentContribution: new (value: string, service: TestService) => Disposable = class InitialContribution extends Disposable {
		constructor(value: string, service: TestService) {
			super();
			events.push(`initial:${value}:${service.instance}`);
			this._register(toDisposable(() => events.push('initial:dispose')));
		}
	};
	const productionDescriptor = wrapInReloadableClass1(() => CurrentContribution, [ITestService]);
	assert.strictEqual(productionDescriptor.ctor, CurrentContribution);
	assert.deepEqual(productionDescriptor.serviceDependencies, [ITestService]);
	const productionContribution = instantiationService.createInstance(productionDescriptor, 'production');
	assert.deepEqual(events, ['initial:production:1']);
	productionContribution.dispose();
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose']);

	enableHotReload();
	const InitialContribution = CurrentContribution;
	const reloadableDescriptor = wrapInReloadableClass1(() => CurrentContribution, [ITestService]);
	assert.deepEqual(reloadableDescriptor.serviceDependencies, [IInstantiationService]);
	const contribution = instantiationService.createInstance(reloadableDescriptor, 'value');
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose', 'initial:value:2']);

	CurrentContribution = class ReplacementContribution extends Disposable {
		constructor(value: string, service: TestService) {
			super();
			events.push(`replacement:${value}:${service.instance}`);
			this._register(toDisposable(() => events.push('replacement:dispose')));
		}
	};
	const accept = (globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { InitialContribution }, newSrc: 'replacementContribution.ts' });
	assert.ok(accept);
	assert.equal(accept({ ReplacementContribution: CurrentContribution }), true);
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose', 'initial:value:2', 'initial:dispose', 'replacement:value:3']);

	contribution.dispose();
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose', 'initial:value:2', 'initial:dispose', 'replacement:value:3', 'replacement:dispose']);
	instantiationService.dispose();
});
