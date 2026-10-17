import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../environment/browser/environmentService.js';
import { IHostService } from '../../../host/browser/host.js';
import { BrowserUpdateService, type IUpdateProvider, type IUpdate } from '../../browser/updateService.js';

function createServices(provider?: IUpdateProvider, restart = async (): Promise<void> => { }): InstantiationService {
	const services = new InstantiationService();
	services.registerInstance(IBrowserWorkbenchEnvironmentService, { webviewExternalEndpoint: 'https://{{uuid}}.example.test', options: { updateProvider: provider } });
	services.registerInstance(IHostService, { hasFocus: true, onDidChangeFocus: Event.None, restart, async openWindow() { }, async getScreenshot() { return undefined; } });
	return services;
}

test('Web update startup and manual checks share the provider request and reload through the host', async () => {
	let finish!: (value: IUpdate | null) => void;
	let checks = 0;
	let reloads = 0;
	using services = createServices({ checkForUpdate() { checks++; return new Promise(resolve => { finish = resolve; }); } }, async () => { reloads++; });
	using update = services.createInstance(BrowserUpdateService);
	const automatic = update.checkAutomatically();
	const manual = update.checkForUpdates();
	await Promise.resolve();
	assert.equal(checks, 1);
	finish({ version: 'build-2' });
	assert.deepEqual(await automatic, { status: 'available', version: 'build-2' });
	assert.deepEqual(await manual, { status: 'available', version: 'build-2' });
	assert.deepEqual(await update.downloadUpdate(), { version: 'build-2' });
	await update.installUpdate();
	assert.equal(reloads, 1);
});

test('Web update checks recover from failures and validate embedder results', async () => {
	let response: unknown = new Error('disconnected');
	using services = createServices({ async checkForUpdate() { if (response instanceof Error) throw response; return response as IUpdate | null; } });
	using update = services.createInstance(BrowserUpdateService);
	await assert.rejects(update.checkForUpdates(), /disconnected/);
	for (response of [undefined, {}, { version: '' }, { version: '  ' }, { version: 2 }]) {
		await assert.rejects(update.checkForUpdates(), /invalid version/);
	}
	response = { version: 'next' };
	assert.deepEqual(await update.checkForUpdates(), { status: 'available', version: 'next' });
	response = null;
	assert.deepEqual(await update.checkForUpdates(), { status: 'current' });
	await assert.rejects(update.downloadUpdate(), /No Web update/);
});

test('Web updates without a provider stay quiet and late checks cannot revive a disposed service', async () => {
	using services = createServices();
	using update = services.createInstance(BrowserUpdateService);
	assert.equal(await update.checkAutomatically(), undefined);
	await assert.rejects(update.checkForUpdates(), /no update provider/);
	let finish!: (value: IUpdate | null) => void;
	using pendingServices = createServices({ checkForUpdate: () => new Promise(resolve => { finish = resolve; }) });
	const pending = pendingServices.createInstance(BrowserUpdateService);
	const checking = pending.checkForUpdates();
	await Promise.resolve();
	pending.dispose();
	finish({ version: 'late' });
	await assert.rejects(checking, isCancellationError);
	assert.throws(() => pending.checkForUpdates(), /disposed/);
});

test('Web update creation requires the registered environment and lifecycle host', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(BrowserUpdateService), /Unknown service/);
	services.registerInstance(IBrowserWorkbenchEnvironmentService, { webviewExternalEndpoint: '', options: {} });
	assert.throws(() => services.createInstance(BrowserUpdateService), /Unknown service: hostService/);
});
