import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ChatTipService } from '../../browser/chatTipService.js';

test('welcome tip dismissal persists once and follows other profile writers until disposal', () => {
	const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', backend: dom.window.localStorage, flushInterval: 0 });
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		using tips = services.createInstance(ChatTipService);
		let dismissals = 0;
		using listener = tips.onDidDismissTip(() => dismissals++);
		assert.equal(tips.getWelcomeTip()?.id, 'attach-files');
		tips.dismissTip();
		tips.dismissTip();
		assert.deepEqual({ tip: tips.getWelcomeTip(), dismissals, stored: storage.get('chat.dismissedWelcomeTip', StorageScope.PROFILE) }, { tip: undefined, dismissals: 1, stored: 'attach-files' });
		storage.store('chat.dismissedWelcomeTip', 'other', StorageScope.WORKSPACE, StorageTarget.USER);
		assert.equal(dismissals, 1);
		storage.remove('chat.dismissedWelcomeTip', StorageScope.PROFILE);
		assert.equal(tips.getWelcomeTip()?.id, 'attach-files');
		assert.equal(dismissals, 2);
		tips.dispose();
		storage.store('chat.dismissedWelcomeTip', 'attach-files', StorageScope.PROFILE, StorageTarget.USER);
		assert.equal(dismissals, 2);
	} finally {
		dom.window.close();
	}
});
