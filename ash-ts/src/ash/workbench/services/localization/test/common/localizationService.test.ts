import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import type { IMarketplaceService } from "../../../../../platform/marketplace/common/marketplaceService.js";
import { MarketplaceLanguagePackService } from "../../../../../platform/languagePacks/browser/marketplaceLanguagePackService.js";
import { builtinLanguagePackCatalogs } from "../../common/localizationCatalogs.js";
import { LocalizationConfiguration, WorkbenchLocaleService, normalizeLocale, resolveLocale } from "../../common/locale.js";
import { WorkbenchLocalizationService } from "../../browser/workbenchLocalizationService.js";
import { resetNlsResolver } from '../../../../../nls.js';
import { JSDOM } from 'jsdom';
import { QuickInputController } from '../../../../../platform/quickinput/browser/quickInputController.js';

test("locale resolution prefers exact, base-language, and English fallback matches", () => {
	assert.equal(normalizeLocale("ZH_cn"), "zh-CN");
	assert.equal(resolveLocale("zh-cn", ["en", "zh-CN", "fr"]), "zh-CN");
	assert.equal(resolveLocale("fr-CA", ["en", "fr"]), "fr");
	assert.equal(resolveLocale("de", ["en", "zh-CN"]), "en");
});

test("locale selection is client-local and only accepts installed packs", async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);

	await localeService.whenReady;
	await assert.rejects(localeService.setLocale("fr"), /not installed/);
	await localeService.setLocale("zh_cn");
	assert.equal(localeService.locale, "zh-CN");
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), "zh-CN");
});

test("localization lookup falls back to English and formats parameters", async () => {
	using configuration = new InMemoryConfigurationService();
	const languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);

	await localization.whenReady;
	assert.equal(localization.translate("ash.settings", "displayLanguage.title", "Fallback"), "Display Language");
	assert.equal(localization.translate("ash.missing", "missing", "Hello {name}", { name: "Ada" }), "Hello Ada");
	await localeService.setLocale('zh-CN');
	assert.equal(localization.translate('ash', 'iPadShowKeyboard.label', 'Show Keyboard'), '显示键盘');
});

test('folding command metadata uses the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		await import('../../../../../editor/contrib/folding/browser/folding.js');
		const { EditorExtensionsRegistry } = await import('../../../../../editor/browser/editorExtensions.js');
		const actions = [...EditorExtensionsRegistry.getEditorActions()];
		const fold = actions.find(action => action.id === 'editor.fold')!.metadata!;
		const unfold = actions.find(action => action.id === 'editor.unfold')!.metadata!;
		assert.deepEqual([fold.description, unfold.description], [
			{ original: 'Collapse the selected folding ranges.', value: '折叠选定的范围。' },
			{ original: 'Expand the selected folding ranges.', value: '展开选定的折叠范围。' },
		]);
		assert.equal(fold.args![0]!.name, '折叠选项');
		assert.match(fold.args![0]!.description!, /从 0 开始的行号/);
	} finally {
		resetNlsResolver();
	}
});

test('Quick Input uses Chinese labels from the selected catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		using controller = new QuickInputController(dom.window.document.body);
		using picker = controller.createQuickPick();
		picker.show();
		assert.equal(dom.window.document.querySelector('[role="dialog"]')?.getAttribute('aria-label'), '快速选择');
		assert.equal(dom.window.document.querySelector('[role="listbox"]')?.getAttribute('aria-label'), '快速选择结果');
		picker.items = [];
		assert.equal(dom.window.document.querySelector('.ash-quick-pick-empty')?.textContent, '没有匹配结果');
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});

test('Go to Offset uses the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		const { GotoOffsetAction } = await import('../../../../../editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js');
		assert.equal(new GotoOffsetAction().label, '转到字符偏移量...');
		assert.equal(localization.translate('ash', 'gotoOffset.input', 'Character offset'), '字符偏移量');
	} finally {
		resetNlsResolver();
	}
});

function createMarketplace(): IMarketplaceService {
	const changes = new Emitter<void>();
	return {
		onDidChangeInstalled: changes.event,
		cachedBrowse: () => undefined,
		browse: () => Promise.reject(new Error("unused")),
		refreshBrowse: () => Promise.reject(new Error("unused")),
		search: async () => [],
		get: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		install: () => Promise.reject(new Error("unused")),
		update: () => Promise.reject(new Error("unused")),
		uninstall: () => Promise.reject(new Error("unused")),
		listInstalled: async () => [],
		acquireCapability: () => Promise.reject(new Error("unused")),
		releaseCapability: async () => {},
		openResource: () => Promise.reject(new Error("unused")),
	};
}
