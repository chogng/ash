import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ChatTipService } from '../../browser/chatTipService.js';

test('welcome tips are dismissed individually and follow other profile writers until disposal', () => {
	const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', backend: dom.window.localStorage, flushInterval: 0 });
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		using tips = services.createInstance(ChatTipService);
		let dismissals = 0;
		using listener = tips.onDidChangeTips(() => dismissals++);
		assert.equal(tips.getWelcomeTip()?.id, 'attach-files');
		assert.equal(tips.getWelcomeTip('attach-files', 1)?.id, 'plan');
		assert.equal(tips.getWelcomeTip('attach-files', -1)?.id, 'new-worktree');
		tips.dismissTip('attach-files');
		tips.dismissTip('attach-files');
		assert.equal(tips.getWelcomeTip()?.id, 'plan');
		assert.equal(storage.getBoolean('chat.dismissedCodeTip.attach-files', StorageScope.PROFILE), true);
		storage.store('chat.dismissedCodeTip.plan', true, StorageScope.WORKSPACE, StorageTarget.USER);
		assert.equal(dismissals, 1);
		using otherWriter = services.createInstance(ChatTipService);
		otherWriter.dismissTip('plan');
		assert.equal(tips.getWelcomeTip()?.id, 'background-send');
		assert.equal(tips.getWelcomeTip('new-worktree', 1)?.id, 'background-send');
		assert.equal(dismissals, 2);
		storage.store('chat.dismissedWelcomeTip', 'attach-files', StorageScope.PROFILE, StorageTarget.USER);
		assert.equal(dismissals, 2);
		let reset = false;
		using resetListener = tips.onDidChangeTips(change => { reset ||= change === 'reset'; });
		otherWriter.clearDismissedTips();
		assert.equal(tips.getWelcomeTip()?.id, 'attach-files');
		assert.equal(tips.getWelcomeTip('attach-files', 1)?.id, 'plan');
		assert.equal(dismissals, 4);
		assert.equal(reset, false);
		tips.clearDismissedTips();
		assert.equal(reset, true);
		tips.dispose();
		otherWriter.dismissTip('plan');
		assert.equal(dismissals, 5);
	} finally {
		dom.window.close();
	}
});

for (const [legacy, firstTip] of [['attach-files', 'plan'], ['code-tip-catalog', 'attach-files']] as const) {
	test(`migrates legacy tip dismissal ${legacy}`, () => {
		const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
		try {
			using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', backend: dom.window.localStorage, flushInterval: 0 });
			using services = new InstantiationService();
			services.registerInstance(IStorageService, storage);
			storage.store('chat.codeTipDismissalsMigrated', true, StorageScope.PROFILE, StorageTarget.USER);
			storage.store('chat.dismissedWelcomeTip', legacy, StorageScope.PROFILE, StorageTarget.USER);
			using tips = services.createInstance(ChatTipService);
			assert.equal(tips.getWelcomeTip()?.id, firstTip);
			assert.equal(storage.get('chat.dismissedWelcomeTip', StorageScope.PROFILE), undefined);
			assert.equal(tips.getWelcomeTip(undefined, 0, ['attach-files'])?.id, legacy === 'attach-files' ? undefined : 'attach-files');
		} finally {
			dom.window.close();
		}
	});
}
