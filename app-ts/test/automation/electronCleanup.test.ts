import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { mock } from 'node:test';
import type { ElectronApplication } from '@playwright/test';
import { test } from 'mocha';
import { DeferredPromise } from '../../src/ash/base/common/async.js';
import { createElectronCleanup } from './electronCleanup.js';

test('Electron cleanup accepts an application that exited after its last window closed', async () => {
	const fixture = createFixture();
	const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
	fixture.application.process = () => { throw new Error('Application channel was disposed'); };
	fixture.exit(0);
	await close();
	assert.deepEqual(fixture.calls, ['application.close', 'daemon.stop']);
});

test('Electron cleanup tolerates windows closing after enumeration and shares concurrent cleanup', async () => {
	const fixture = createFixture();
	fixture.addPage('Workbench');
	fixture.addPage('Sessions');
	const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
	const closing = Promise.all([close(), close()]);
	await fixture.closeStarted.p;
	fixture.exit(0);
	await closing;
	await close();
	assert.deepEqual(fixture.calls, ['Workbench.close', 'Sessions.close', 'application.close', 'daemon.stop']);
});

test('Electron cleanup does not release the profile or stop its daemon until the process exits', async () => {
	const fixture = createFixture();
	let finished = false;
	const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
	const closing = close().then(() => { finished = true; });
	await fixture.closeStarted.p;
	await setImmediate();
	assert.deepEqual({ finished, calls: fixture.calls }, { finished: false, calls: ['application.close'] });
	fixture.exit(0);
	await closing;
	assert.deepEqual({ finished, listeners: fixture.process.listenerCount('exit') }, { finished: true, listeners: 0 });
});

test('Electron cleanup reports a genuine page-close failure after releasing the process and daemon', async () => {
	const fixture = createFixture();
	const failure = new Error('Page transport failed');
	fixture.addPage('Workbench', failure);
	fixture.addPage('Sessions');
	const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
	const rejected = assert.rejects(close(), error => error === failure);
	await fixture.closeStarted.p;
	fixture.exit(0);
	await rejected;
	assert.deepEqual(fixture.calls, ['Workbench.close', 'Sessions.close', 'application.close', 'daemon.stop']);
});

for (const status of [{ code: 7, signal: null }, { code: null, signal: 'SIGTERM' as const }]) {
	test(`Electron cleanup reports abnormal exit ${JSON.stringify(status)} without leaking the daemon`, async () => {
		const fixture = createFixture();
		fixture.exit(status.code, status.signal);
		const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
		await assert.rejects(close(), /Electron exited abnormally/u);
		assert.deepEqual(fixture.calls, ['application.close', 'daemon.stop']);
	});
}

test('Electron cleanup preserves both application and daemon failures', async () => {
	const fixture = createFixture();
	const applicationError = new Error('Application close failed');
	const daemonError = new Error('Daemon stop failed');
	fixture.application.close = async () => { fixture.calls.push('application.close'); fixture.exit(0); throw applicationError; };
	const close = createElectronCleanup(fixture.application, async () => { fixture.calls.push('daemon.stop'); throw daemonError; });
	await assert.rejects(close(), error => error instanceof AggregateError && error.errors[0] === applicationError && error.errors[1] === daemonError);
});

test('Electron cleanup bounds a missing process exit and removes its listener', async () => {
	const fixture = createFixture();
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
		const rejected = assert.rejects(close(), /Electron cleanup.*process exit/u);
		void rejected.catch(() => {});
		await fixture.closeStarted.p;
		await setImmediate();
		mock.timers.tick(30_000);
		await rejected;
		assert.deepEqual({ calls: fixture.calls, listeners: fixture.process.listenerCount('exit') }, { calls: ['application.close'], listeners: 0 });
	} finally {
		mock.timers.reset();
	}
});

for (const blocked of ['page', 'application']) {
	test(`Electron cleanup bounds a hanging ${blocked} close without claiming a live process exited`, async () => {
		const fixture = createFixture();
		const blockedClose = new DeferredPromise<void>();
		const page = fixture.addPage('Workbench');
		page.close = async () => {
			fixture.calls.push('Workbench.close');
			if (blocked === 'page') await blockedClose.p;
		};
		fixture.application.close = async () => {
			fixture.calls.push('application.close');
			if (blocked === 'application') await blockedClose.p;
			fixture.exit(0);
		};
		mock.timers.enable({ apis: ['setTimeout'] });
		let state = 'pending';
		const close = createElectronCleanup(fixture.application, fixture.stopDaemon);
		const outcome = close().then(() => { state = 'resolved'; }, error => { state = 'rejected'; return error as Error; });
		try {
			await setImmediate();
			mock.timers.tick(30_000);
			await setImmediate();
			assert.equal(state, 'rejected');
			assert.match((await outcome as Error).message, /Electron cleanup.*30000ms/u);
			assert.equal(fixture.calls.includes('daemon.stop'), blocked === 'page');
			assert.equal(fixture.process.listenerCount('exit'), 0);
		} finally {
			void blockedClose.complete();
			await outcome;
			mock.timers.reset();
		}
	});
}

function createFixture() {
	const process = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
	const calls: string[] = [];
	const closeStarted = new DeferredPromise<void>();
	const pages: { close(): Promise<void> }[] = [];
	const application = {
		process: () => process,
		windows: () => pages,
		evaluate: async () => { throw new Error('electronApplication.evaluate: Target page, context or browser has been closed'); },
		close: async () => { calls.push('application.close'); void closeStarted.complete(); },
	} as unknown as ElectronApplication;
	return {
		process, calls, closeStarted, application,
		stopDaemon: async () => { calls.push('daemon.stop'); },
		addPage(name: string, failure?: Error) {
			// Playwright Page.close is idempotent even if this page closes before its RPC reaches the browser.
			const page = { close: async () => { calls.push(`${name}.close`); if (failure) throw failure; } };
			pages.push(page);
			return page;
		},
		exit(code: number | null, signal: NodeJS.Signals | null = null) { process.exitCode = code; process.signalCode = signal; process.emit('exit', code, signal); },
	};
}
