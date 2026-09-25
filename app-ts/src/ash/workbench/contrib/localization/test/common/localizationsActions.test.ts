import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { commandActionLabel } from '../../../../../platform/action/common/action.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILanguagePackService } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import type { LanguagePackCatalog, LanguagePackInfo } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import type { LanguagePackPackage } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ILocaleService, LocalizationConfiguration } from '../../../../services/localization/common/locale.js';
import { WorkbenchLocaleService } from '../../../../services/localization/browser/localeService.js';
import { WorkbenchLocalizationService } from '../../../../services/localization/browser/workbenchLocalizationService.js';
import { ClearDisplayLanguageAction, ConfigureDisplayLanguageAction } from '../../common/localizationsActions.js';

test('display language commands select an installed catalog and clear the preference', async () => {
	using environment = new LanguageActionEnvironment();
	try {
		await environment.localization.whenReady;
		await environment.commands.executeCommand(ConfigureDisplayLanguageAction.ID);
		const picker = environment.quickInput.picker!;
		assert.equal(picker.ariaLabel, 'Select Display Language');
		const changed = nextLocaleChange(environment.locale);
		picker.accept(picker.items.find(item => item.label === '简体中文')!);
		await changed;
		assert.equal(environment.configuration.getValue(LocalizationConfiguration.locale), 'zh-CN');
		assert.equal(environment.localization.translate('ash.settings', 'displayLanguage.title', 'Display Language'), '显示语言');
		assert.equal(commandActionLabel(new ConfigureDisplayLanguageAction().desc.title), '配置显示语言');

		await environment.commands.executeCommand(ClearDisplayLanguageAction.ID);
		assert.equal(environment.locale.locale, 'en');
		assert.equal(environment.configuration.getValue(LocalizationConfiguration.locale), 'en');
		assert.deepEqual(environment.errors, []);
	} finally {
		resetNlsResolver();
	}
});

test('display language command installs a Marketplace catalog before selecting it', async () => {
	using environment = new LanguageActionEnvironment();
	try {
		await environment.localization.whenReady;
		await environment.commands.executeCommand(ConfigureDisplayLanguageAction.ID);
		const picker = environment.quickInput.picker!;
		picker.setQuery('French');
		const packageItem = await picker.waitForItem('French pack');
		const changed = nextLocaleChange(environment.locale);
		picker.accept(packageItem);
		await changed;
		assert.deepEqual(environment.languagePacks.installs, [['fr-pack', '1']]);
		assert.equal(environment.locale.locale, 'fr');
		assert.equal(environment.localization.translate('ash.settings', 'displayLanguage.title', 'Display Language'), 'Langue d’affichage');
		assert.deepEqual(environment.errors, []);
	} finally {
		resetNlsResolver();
	}
});

class LanguageActionEnvironment extends Disposable {
	public readonly configuration = this._register(new InMemoryConfigurationService());
	public readonly languagePacks = this._register(new TestLanguagePacks());
	public readonly locale = this._register(new WorkbenchLocaleService(this.configuration, this.languagePacks));
	public readonly localization = this._register(new WorkbenchLocalizationService(this.locale, this.languagePacks));
	public readonly quickInput = new TestQuickInputService();
	public readonly errors: string[] = [];
	public readonly commands: CommandService;

	constructor() {
		super();
		const services = new ServiceContainer();
		services.registerInstance(ILanguagePackService, this.languagePacks);
		services.registerInstance(ILocaleService, this.locale);
		services.registerInstance(IQuickInputService, this.quickInput);
		services.registerInstance(INotificationService, {
			error: (message: string) => {
				this.errors.push(message);
				return { close() {} };
			},
		} as INotificationService);
		this.commands = new CommandService(services);
		services.registerInstance(ICommandService, this.commands);
		this._register(registerAction2(ConfigureDisplayLanguageAction));
		this._register(registerAction2(ClearDisplayLanguageAction));
	}
}

class TestLanguagePacks extends Disposable implements ILanguagePackService {
	private readonly changed = this._register(new Emitter<void>());
	private readonly installedCatalogs: LanguagePackCatalog[] = [...builtinLanguagePackCatalogs];
	public readonly onDidChange = this.changed.event;
	public readonly whenReady = Promise.resolve();
	public readonly installs: Array<[string, string | undefined]> = [];
	public readonly installedPackages: readonly LanguagePackPackage[] = [];

	public get catalogs(): readonly LanguagePackCatalog[] {
		return this.installedCatalogs;
	}

	public get availableLocales(): readonly LanguagePackInfo[] {
		return this.installedCatalogs.map(catalog => ({
			locale: catalog.locale,
			languageName: catalog.languageName,
			localizedLanguageName: catalog.localizedLanguageName,
			source: catalog.locale === 'fr' ? 'marketplace' : 'builtin',
		}));
	}

	public async search(): Promise<readonly LanguagePackPackage[]> {
		return [{ id: 'fr-pack', version: '1', displayName: 'French pack', description: '', installed: false }];
	}

	public async install(packageId: string, version?: string): Promise<void> {
		this.installs.push([packageId, version]);
		this.installedCatalogs.push({
			schemaVersion: 1,
			locale: 'fr',
			languageName: 'French',
			localizedLanguageName: 'Français',
			catalogVersion: builtinLanguagePackCatalogs[0]!.catalogVersion,
			bundles: { 'ash.settings': { 'displayLanguage.title': 'Langue d’affichage' } },
		});
		this.changed.fire();
	}

	public async refresh(): Promise<void> {}
}

class TestQuickInputService implements IQuickInputService {
	public picker: TestQuickPick<IQuickPickItem> | undefined;

	public createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.picker = picker as unknown as TestQuickPick<IQuickPickItem>;
		return picker;
	}

	public async input(): Promise<string | undefined> {
		return undefined;
	}
}

class TestQuickPick<TItem extends IQuickPickItem> extends Disposable implements IQuickPick<TItem> {
	private readonly accepted = this._register(new Emitter<TItem>());
	private readonly changed = this._register(new Emitter<string>());
	private readonly hidden = this._register(new Emitter<void>());
	private readonly itemsChanged = this._register(new Emitter<void>());
	private currentItems: readonly TItem[] = [];
	public readonly onDidAccept = this.accepted.event;
	public readonly onDidChangeValue = this.changed.event;
	public readonly onDidHide = this.hidden.event;
	public readonly onDidBlur = Event.None;
	public readonly onDidTriggerItemButton = Event.None;
	public ariaLabel = '';
	public placeholder = '';
	public value = '';
	public valueSelection = { start: 0, end: 0 };
	public filterValue = (value: string): string => value;

	public get items(): readonly TItem[] {
		return this.currentItems;
	}

	public set items(items: readonly TItem[]) {
		this.currentItems = items;
		this.itemsChanged.fire();
	}

	public waitForItem(label: string): Promise<TItem> {
		const existing = this.currentItems.find(item => item.label === label);
		if (existing) {
			return Promise.resolve(existing);
		}
		return new Promise(resolve => {
			const listener = this.itemsChanged.event(() => {
				const item = this.currentItems.find(candidate => candidate.label === label);
				if (item) {
					listener.dispose();
					resolve(item);
				}
			});
		});
	}

	public accept(item: TItem): void {
		this.accepted.fire(item);
	}

	public setQuery(value: string): void {
		this.value = value;
		this.changed.fire(value);
	}

	public show(): void {}
	public hide(): void { this.hidden.fire(); }
}

function nextLocaleChange(locale: WorkbenchLocaleService): Promise<void> {
	return new Promise(resolve => {
		const listener = locale.onDidChangeLocale(() => {
			listener.dispose();
			resolve();
		});
	});
}
