import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import type { DownloadItem } from 'electron/main';
import { suite, suiteSetup, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import { StorageScope } from '../../../storage/common/storage.js';
import { IApplicationStorageMainService, StorageMainService } from '../../../storage/electron-main/storageMainService.js';

suite('Desktop browser download persistence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let BrowserDownloadMainService: typeof import('../../electron-main/browserDownloadMainService.js').BrowserDownloadMainService;

	suiteSetup(async () => {
		// Only Electron's built-ins are replaced. The download service uses the real storage writer.
		const boundaryUrl = 'data:text/javascript,export const app = {}, dialog = {}, shell = {};';
		const hooks = registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === 'electron/main' || specifier === 'electron') {
					return { url: boundaryUrl, shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
		});
		try {
			({ BrowserDownloadMainService } = await import('../../electron-main/browserDownloadMainService.js'));
		} finally {
			hooks.deregister();
		}
	});

	test('storage close saves an active download before disposal and ignores later progress', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-downloads-'));
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const file = join(directory, 'state.json');
			using storage = new StorageMainService(file);
			await storage.initialize();
			using services = new InstantiationService();
			services.registerInstance(IApplicationStorageMainService, storage);
			services.registerInstance(ILogService, new NullLoggerService());
			using downloads = services.createInstance(BrowserDownloadMainService);
			await downloads.configure(directory, true);
			await downloads.getState();

			const path = join(directory, 'example.txt');
			const url = 'https://example.test/example.txt';
			let receivedBytes = 8;
			let cancels = 0;
			const item = Object.assign(new EventEmitter(), {
				getFilename: () => 'example.txt',
				getSavePath: () => path,
				getURLChain: () => [url],
				getReceivedBytes: () => receivedBytes,
				getTotalBytes: () => 16,
				setSaveDialogOptions: () => { },
				cancel: () => { cancels++; },
			});
			assert.equal(downloads.track(item as unknown as DownloadItem), true);
			const [active] = (await downloads.getState()).items;
			assert.equal(active?.state, 'progressing');

			await storage.close();
			try {
				receivedBytes++;
				item.emit('updated', undefined, 'progressing');
				mock.timers.tick(500);
			} finally {
				downloads.dispose();
			}
			assert.equal(cancels, 1);
			assert.equal(item.listenerCount('updated'), 0);
			assert.equal(item.listenerCount('done'), 0);

			using reopened = new StorageMainService(file);
			await reopened.initialize();
			const snapshot = await reopened.getItems({ scope: StorageScope.APPLICATION, id: 'application' });
			assert.deepEqual(JSON.parse(snapshot.entries['browser.downloads']!.value), [{ ...active, state: 'interrupted' }]);
		} finally {
			mock.timers.reset();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
