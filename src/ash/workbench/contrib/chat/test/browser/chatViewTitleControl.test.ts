import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ChatViewTitleControl } from '../../browser/widgetHosts/viewPane/chatViewTitleControl.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

test('Conversation title keeps one history picker open and restores focus when dismissed', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createTestEditorServices();
		services.registerInstance(IChatSessionNavigationService, {
			getActiveConversation: () => undefined,
		} as IChatSessionNavigationService);
		using commands = new CommandService(services);
		services.registerInstance(IMenuService, new MenuService(commands, services.get(IContextKeyService)));
		services.registerInstance(IContextMenuService, { showContextMenu: () => {} } as unknown as IContextMenuService);
		const dismissed = new DeferredPromise<void>();
		let opened = 0;
		using control = services.createInstance(ChatViewTitleControl, dom.window.document.body, 'chat', () => {
			opened++;
			return dismissed.p;
		});
		control.update('Working conversation', 'chat-panel');
		const button = dom.window.document.querySelector<HTMLButtonElement>('.ash-chat-view-title-button')!;
		button.focus();
		button.click();
		button.click();
		assert.equal(opened, 1);
		assert.equal(button.getAttribute('aria-expanded'), 'true');
		assert.equal(button.getAttribute('aria-controls'), 'chat-panel');
		assert.equal(dom.window.document.querySelector('[role="tablist"]'), null);
		const label = button.querySelector('span');
		control.update('Another conversation', 'other-panel');
		assert.equal(button.querySelector('span'), label);
		assert.equal(button.getAttribute('aria-label'), 'Switch conversation: Another conversation');
		button.blur();
		await dismissed.complete();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(button.getAttribute('aria-expanded'), 'false');
		assert.equal(dom.window.document.activeElement, button);
	} finally {
		dom.window.close();
	}
});

test('Conversation title and actions use the client language', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages('zh-CN', chinese.bundles);
		using services = createTestEditorServices();
		services.registerInstance(IChatSessionNavigationService, {
			getActiveConversation: () => undefined,
		} as IChatSessionNavigationService);
		using commands = new CommandService(services);
		services.registerInstance(IMenuService, new MenuService(commands, services.get(IContextKeyService)));
		services.registerInstance(IContextMenuService, { showContextMenu: () => {} } as unknown as IContextMenuService);
		using control = services.createInstance(ChatViewTitleControl, dom.window.document.body, 'chat', async () => {});
		const button = dom.window.document.querySelector<HTMLButtonElement>('.ash-chat-view-title-button')!;
		assert.equal(button.textContent, '聊天');
		assert.equal(button.getAttribute('aria-label'), '切换会话：聊天');
		assert.ok(dom.window.document.querySelector('[aria-label="聊天操作"]'));
		assert.ok(dom.window.document.querySelector('[aria-label="聊天布局"]'));
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});
