import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { App, GPUFeatureStatus } from 'electron';
import { test } from 'mocha';
import { GPUProcessMainService, IGPUProcessMainService } from '../../electron-main/gpuProcessMainService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../../instantiation/common/descriptors.js';

class GpuApplication extends EventEmitter {
	public status = {} as GPUFeatureStatus;
	public getGPUFeatureStatus(): GPUFeatureStatus {
		return this.status;
	}
	public update(status: GPUFeatureStatus): void {
		this.status = status;
		this.emit('gpu-info-update');
	}
	public exit(type = 'GPU', reason = 'crashed'): void {
		this.emit('child-process-gone', {}, { type, reason });
	}
}

const accelerated = { gpu_compositing: 'enabled', rasterization: 'enabled' } as GPUFeatureStatus;
const software = { gpu_compositing: 'disabled_software', rasterization: 'disabled_software' } as GPUFeatureStatus;

test('GPU lifecycle invalidates stale facts before exit and follows repeated recovery', () => {
	const application = new GpuApplication();
	using service = new GPUProcessMainService(application as unknown as App);
	const observed: unknown[] = [];
	using changes = service.onDidUpdateFeatureStatus(status => observed.push(status));
	using exits = service.onDidExitProcess(exit => observed.push({ ...exit, status: service.featureStatus }));
	assert.equal(service.featureStatus, undefined);
	application.update(accelerated);
	application.update({ ...accelerated });
	application.exit('Utility');
	assert.deepEqual(observed, [accelerated]);
	application.exit();
	// The Electron getter deliberately remains accelerated until recovery.
	assert.deepEqual(application.getGPUFeatureStatus(), accelerated);
	assert.equal(service.featureStatus, undefined);
	application.update(accelerated);
	application.exit('GPU', 'killed');
	application.update(software);
	application.update(software);
	assert.deepEqual(observed, [accelerated, undefined, { reason: 'crashed', status: undefined }, accelerated, undefined, { reason: 'killed', status: undefined }, software]);
});

test('late GPU initialization snapshots software state and releases Electron listeners', () => {
	const application = new GpuApplication();
	application.update({ ...software });
	const service = new GPUProcessMainService(application as unknown as App);
	const snapshot = service.featureStatus!;
	assert.deepEqual(snapshot, software);
	application.status.gpu_compositing = 'enabled';
	assert.deepEqual(snapshot, software);
	assert.throws(() => {
		snapshot.gpu_compositing = 'enabled';
	}, TypeError);
	const updates: unknown[] = [];
	using subscription = service.onDidUpdateFeatureStatus(status => updates.push(status));
	service.dispose();
	assert.equal(application.listenerCount('gpu-info-update'), 0);
	assert.equal(application.listenerCount('child-process-gone'), 0);
	application.update(accelerated);
	application.exit();
	assert.deepEqual(updates, []);
});

test('Desktop service scope owns exactly one eagerly resolved GPU monitor', () => {
	const application = new GpuApplication();
	const scope = new InstantiationService(new ServiceCollection([IGPUProcessMainService, new SyncDescriptor(GPUProcessMainService, [application])]));
	const service = scope.get(IGPUProcessMainService);
	assert.equal(scope.get(IGPUProcessMainService), service);
	assert.equal(application.listenerCount('gpu-info-update'), 1);
	assert.equal(application.listenerCount('child-process-gone'), 1);
	scope.dispose();
	assert.equal(application.listenerCount('gpu-info-update'), 0);
	assert.equal(application.listenerCount('child-process-gone'), 0);
});

test('failed initial GPU collection removes both Electron subscriptions', () => {
	const application = new GpuApplication();
	application.getGPUFeatureStatus = () => {
		throw new Error('Deliberate GPU collection failure');
	};
	assert.throws(() => new GPUProcessMainService(application as unknown as App), /Deliberate GPU collection failure/);
	assert.equal(application.listenerCount('gpu-info-update'), 0);
	assert.equal(application.listenerCount('child-process-gone'), 0);
});
