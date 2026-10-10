import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { TunnelService } from '../../browser/tunnelService.js';

test('Web without a tunnel provider has no SSH capability or Main dependency', async () => {
	using services = new InstantiationService();
	using service = services.createInstance(TunnelService);
	assert.deepEqual(await service.tunnels, []);
	assert.equal(service.openTunnel(undefined, '127.0.0.1', 3000), undefined);
	await service.closeTunnel('127.0.0.1', 3000);
	service.dispose();
	assert.throws(() => service.openTunnel(undefined, '127.0.0.1', 3000), /disposed/);
});
