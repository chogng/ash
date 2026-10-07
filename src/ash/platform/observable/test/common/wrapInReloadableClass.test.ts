import assert from 'node:assert/strict';
import { test } from 'mocha';
import { enableHotReload } from '../../../../base/common/hotReload.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { wrapInReloadableClass1 } from '../../common/wrapInReloadableClass.js';
import { hotClassGetOriginalInstance } from '../../common/wrapInHotClass.js';

type HotReloadGlobal = typeof globalThis & {
	$hotReload_applyNewExports?: (request: { readonly oldExports: Record<string, unknown>; readonly newSrc: string; }) => ((newExports: Record<string, unknown>) => boolean) | undefined;
};

test('wrapInReloadableClass1 keeps one caller argument and resolves services for every instance', () => {
	const events: string[] = [];
	interface TestService {
		readonly instance: number;
	}
	const ITestService = createServiceIdentifier<TestService>('testService');
	using instantiationService = new InstantiationService();
	let serviceInstance = 0;
	instantiationService.registerTransient(ITestService, () => ({ instance: ++serviceInstance }));

	class InitialContribution extends Disposable {
		constructor(value: string, @ITestService service: TestService) {
			super();
			events.push(`initial:${value}:${service.instance}`);
			this._register(toDisposable(() => events.push('initial:dispose')));
		}
	}
	const CurrentContribution: new (value: string, service: TestService) => Disposable = InitialContribution;
	const productionDescriptor = wrapInReloadableClass1(() => CurrentContribution);
	assert.strictEqual(productionDescriptor, CurrentContribution);
	const productionContribution = instantiationService.createInstance(productionDescriptor, 'production');
	assert.deepEqual(events, ['initial:production:1']);
	productionContribution.dispose();
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose']);

	enableHotReload();
	const reloadableDescriptor = wrapInReloadableClass1(() => CurrentContribution);
	using contribution = instantiationService.createInstance(reloadableDescriptor, 'value');
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose', 'initial:value:2']);

	class ReplacementContribution extends Disposable {
		constructor(value: string, @ITestService service: TestService) {
			super();
			events.push(`replacement:${value}:${service.instance}`);
			this._register(toDisposable(() => events.push('replacement:dispose')));
		}
	}
	const accept = (globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { InitialContribution }, newSrc: 'replacementContribution.ts' });
	assert.ok(accept);
	assert.equal(accept({ InitialContribution: ReplacementContribution }), true);
	assert.ok(hotClassGetOriginalInstance(contribution) instanceof ReplacementContribution);
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose', 'initial:value:2', 'initial:dispose', 'replacement:value:3']);
	const secondAccept = (globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { InitialContribution: ReplacementContribution }, newSrc: 'replacementContribution.ts' });
	assert.ok(secondAccept);
	class FinalContribution extends Disposable {
		constructor(value: string, @ITestService service: TestService) {
			super();
			events.push(`final:${value}:${service.instance}`);
			this._register(toDisposable(() => events.push('final:dispose')));
		}
	}
	assert.equal(secondAccept({ InitialContribution: FinalContribution }), true);
	assert.ok(hotClassGetOriginalInstance(contribution) instanceof FinalContribution);

	contribution.dispose();
	assert.strictEqual(hotClassGetOriginalInstance(contribution), contribution);
	assert.deepEqual(events, ['initial:production:1', 'initial:dispose', 'initial:value:2', 'initial:dispose', 'replacement:value:3', 'replacement:dispose', 'final:value:4', 'final:dispose']);
	assert.equal((globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { InitialContribution: FinalContribution }, newSrc: 'replacementContribution.ts' }), undefined);
});
