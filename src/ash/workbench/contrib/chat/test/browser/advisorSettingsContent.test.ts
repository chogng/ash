import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import type { AdvisorConfig, IChatService } from '../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { AdvisorSettingsContent } from '../../browser/advisorSettingsContent.js';
import type { ILanguageModelsService } from '../../common/languageModels.js';

test('Advisor focuses its saved model, Disable when disabled and the menu when the saved model is hidden', async () => {
	const dom = new JSDOM('<body></body>');
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', {
		configurable: true,
		value(this: Element, options: ScrollToOptions): void {
			this.scrollLeft = options.left ?? this.scrollLeft;
			this.scrollTop = options.top ?? this.scrollTop;
		},
	});
	try {
		using resources = new DisposableStore();
		const document = dom.window.document;
		const model: ModelCatalogEntry = {
			model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'GPT-6.1 Sol', longContext: null,
		};
		let saved: AdvisorConfig = { model: model.model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
		let modelVisible = true;
		const content = resources.add(new AdvisorSettingsContent(document.body,
			{ readAdvisorDefault: async () => saved } as IChatService,
			{ onDidChangeModels: Event.None, listAdvisorModels: async () => [model], isModelVisible: () => modelVisible } as unknown as ILanguageModelsService,
			resources.add(new BrowserContextViewService(document.body)),
			resources.add(new ContextKeyService()),
			{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService,
			resources.add(new InMemoryConfigurationService()),
			{} as ILocalizationService,
		));
		document.body.append(content.domNode);
		const button = content.domNode.querySelector<HTMLButtonElement>('[aria-label="Advisor model"]')!;
		for (const state of [
			{ enabled: true, visible: true, label: 'GPT-6.1 Sol' },
			{ enabled: false, visible: true, label: 'Disable' },
			{ enabled: true, visible: false, label: null },
		]) {
			saved = { ...saved, enabled: state.enabled };
			modelVisible = state.visible;
			let loaded!: () => void;
			const ready = new Promise<void>(resolve => { loaded = resolve; });
			const listener = resources.add(content.onDidChange(loaded));
			content.setVisible(true);
			await ready;
			listener.dispose();
			button.focus();
			button.click();
			const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
			assert.equal(document.activeElement, state.label ? menu.querySelector(`[aria-label="${state.label}"]`) : menu);
			assert.equal(menu.querySelector('[aria-checked="true"]')?.getAttribute('aria-label') ?? null, state.label);
			menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			assert.equal(document.activeElement, button);
			content.setVisible(false);
		}
	} finally {
		dom.window.close();
	}
});
