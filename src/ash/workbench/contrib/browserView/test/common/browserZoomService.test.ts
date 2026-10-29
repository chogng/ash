import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { BrowserZoomService } from '../../common/browserZoomService.js';
import { browserZoomDefaultIndex } from '../../../../../platform/browserView/common/browserView.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

suite('Browser host zoom preferences', () => {
	test('window zoom is the default, explicit defaults take precedence and host overrides survive changes', async () => {
		const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
		try {
			using configuration = new InMemoryConfigurationService(Registry.as<IConfigurationRegistry>(Extensions.Configuration));
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'zoom-defaults',
				flushInterval: 0,
			});
			using zoom = new BrowserZoomService(storage, configuration);
			zoom.notifyWindowZoomChanged(1.44);
			assert.equal(zoom.getEffectiveZoomIndex(undefined, false), 10);
			zoom.setHostZoomIndex('override.test', 12, false);
			await configuration.updateValue('workbench.browser.pageZoom', '125%', ConfigurationTarget.MEMORY);
			zoom.notifyWindowZoomChanged(2);
			assert.deepEqual([zoom.getEffectiveZoomIndex(undefined, false), zoom.getEffectiveZoomIndex('override.test', false)], [9, 12]);
			zoom.setHostZoomIndex('follows.test', 9, false);
			await configuration.updateValue('workbench.browser.pageZoom', 'Match Window', ConfigurationTarget.MEMORY);
			assert.deepEqual([zoom.getEffectiveZoomIndex('follows.test', false), zoom.getEffectiveZoomIndex('override.test', false)], [12, 12]);
		} finally {
			dom.window.close();
		}
	});
	test('persistent preferences survive service recreation while ephemeral preferences stay private', () => {
		const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
		try {
			using configuration = new InMemoryConfigurationService(Registry.as<IConfigurationRegistry>(Extensions.Configuration));
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'zoom-test',
				flushInterval: 0,
			});
			using zoom = new BrowserZoomService(storage, configuration);
			zoom.setHostZoomIndex('example.test', 10, false);
			const persisted = storage.get('browserView.zoomPerHost', StorageScope.PROFILE);
			zoom.setHostZoomIndex('private.test', 11, true);
			assert.equal(storage.get('browserView.zoomPerHost', StorageScope.PROFILE), persisted);
			assert.equal(zoom.getEffectiveZoomIndex('private.test', true), 11);
			using reopened = new BrowserZoomService(storage, configuration);
			assert.deepEqual(
				[reopened.getEffectiveZoomIndex('example.test', false), reopened.getEffectiveZoomIndex('private.test', false), reopened.getEffectiveZoomIndex('private.test', true)],
				[10, browserZoomDefaultIndex, browserZoomDefaultIndex],
			);
			zoom.setHostZoomIndex('example.test', browserZoomDefaultIndex, false);
			assert.equal(reopened.getEffectiveZoomIndex('example.test', false), browserZoomDefaultIndex);
		} finally {
			dom.window.close();
		}
	});
	test('external writes notify readers and invalid persisted values fail validation', () => {
		const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
		try {
			using configuration = new InMemoryConfigurationService(Registry.as<IConfigurationRegistry>(Extensions.Configuration));
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'zoom-test',
				flushInterval: 0,
			});
			using zoom = new BrowserZoomService(storage, configuration);
			let changed = false;
			using listener = zoom.onDidChangeZoom(() => {
				changed = true;
			});
			storage.store('browserView.zoomPerHost', '{"example.test":12}', StorageScope.PROFILE, StorageTarget.MACHINE);
			assert.equal(changed, true);
			assert.equal(zoom.getEffectiveZoomIndex('example.test', false), 12);
			storage.store('browserView.zoomPerHost', '{"example.test":99}', StorageScope.PROFILE, StorageTarget.MACHINE);
			assert.throws(() => zoom.getEffectiveZoomIndex('example.test', false), /Invalid browser zoom/);
		} finally {
			dom.window.close();
		}
	});
});

import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import '../../electron-browser/features/browserEditorZoomFeature.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
