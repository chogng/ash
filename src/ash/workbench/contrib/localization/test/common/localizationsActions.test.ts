import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { QuickInputType, type IQuickPickDidAcceptEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { Event as QuickPickTestEvent } from '../../../../../base/common/event.js';
import { createTestLocaleService } from '../../../../services/localization/test/common/localizationTestUtils.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { commandActionLabel } from '../../../../../platform/action/common/action.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import {
	ILanguagePackService,
	type ILanguagePackItem,
} from '../../../../../platform/languagePacks/common/languagePacks.js';
import type { LanguagePackCatalog } from '../../../../../platform/languagePacks/common/languagePackContract.js';
import {
	IExtensionManagementService,
	type ExtensionsInstalledPackage,
	type ExtensionsSearchOptions,
} from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import {
	IQuickInputService,
	type IQuickPick,
	type IQuickPickItem,
} from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
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
		const changed = nextPreferenceChange(environment.configuration);
		picker.chooseItem(picker.items.find(item => item.label === '简体中文')!);
		await changed;
		assert.equal(environment.configuration.getValue(LocalizationConfiguration.locale), 'zh-CN');
		assert.equal(
			environment.localization.translate('ash.settings', 'displayLanguage.title', 'Display Language'),
			'Display Language',
		);
		assert.equal(commandActionLabel(new ConfigureDisplayLanguageAction().desc.title), 'Configure Display Language');

		await environment.commands.executeCommand(ClearDisplayLanguageAction.ID);
		assert.equal(environment.locale.locale, 'en');
		assert.equal(environment.configuration.getValue(LocalizationConfiguration.locale), 'en');
		assert.deepEqual(environment.errors, []);
	} finally {
		resetNlsResolver();
	}
});

test('display language command installs a Extensions catalog before selecting it', async () => {
	using environment = new LanguageActionEnvironment();
	try {
		await environment.localization.whenReady;
		await environment.commands.executeCommand(ConfigureDisplayLanguageAction.ID);
		const picker = environment.quickInput.picker!;
		picker.setQuery('French');
		const packageItem = await picker.waitForItem('French pack');
		const changed = nextPreferenceChange(environment.configuration);
		picker.chooseItem(packageItem);
		await changed;
		assert.deepEqual(environment.installs, [['fr-pack', '1']]);
		assert.deepEqual(environment.searches, [['French', { packageType: 'localization', limit: 30 }]]);
		assert.equal(environment.configuration.getValue(LocalizationConfiguration.locale), 'fr');
		assert.equal(environment.locale.locale, 'en');
		assert.equal(
			environment.localization.translate('ash.settings', 'displayLanguage.title', 'Display Language'),
			'Display Language',
		);
		assert.deepEqual(environment.errors, []);
	} finally {
		resetNlsResolver();
	}
});

test('display language search excludes installed package versions through Extension Management', async () => {
	using environment = new LanguageActionEnvironment();
	environment.installedPackages.push({
		installationId: 'installed.fr',
		package: { id: 'fr-pack', version: '1', digest: `sha256:${'a'.repeat(64)}` },
		state: 'installed',
		capabilities: [],
	});
	await environment.commands.executeCommand(ConfigureDisplayLanguageAction.ID);
	const picker = environment.quickInput.picker!;
	const searched = new Promise<void>(resolve => {
		const listener = picker.onDidChangeItems(() => {
			listener.dispose();
			resolve();
		});
	});
	picker.setQuery('French');
	await searched;
	assert.equal(
		picker.items.some(item => item.label === 'French pack'),
		false,
	);
	assert.deepEqual(environment.searches, [['French', { packageType: 'localization', limit: 30 }]]);
	assert.deepEqual(environment.errors, []);
	picker.hide();
});

class LanguageActionEnvironment extends Disposable {
	public readonly configuration = this._register(new InMemoryConfigurationService());
	public readonly languagePacks = this._register(new TestLanguagePacks());
	public readonly locale = this._register(createTestLocaleService(this.configuration, this.languagePacks));
	public readonly localization = this._register(new WorkbenchLocalizationService());
	public readonly quickInput = new TestQuickInputService();
	public readonly errors: string[] = [];
	public readonly commands: CommandService;
	public readonly installs: Array<[string, string | undefined]> = [];
	public readonly searches: Array<[string, ExtensionsSearchOptions | undefined]> = [];
	public readonly installedPackages: ExtensionsInstalledPackage[] = [];

	constructor() {
		super();
		const services = new InstantiationService();
		services.registerInstance(ILanguagePackService, this.languagePacks);
		services.registerInstance(IExtensionManagementService, {
			search: async (query: string, options?: ExtensionsSearchOptions) => {
				this.searches.push([query, options]);
				return [
					{
						id: 'fr-pack',
						version: '1',
						packageType: 'localization',
						displayName: 'French pack',
						description: '',
					},
				];
			},
			listInstalled: async () => this.installedPackages,
			install: async (id: string, version?: string) => {
				this.installs.push([id, version]);
				this.languagePacks.queueFrenchCatalog();
			},
		} as unknown as IExtensionManagementService);
		services.registerInstance(ILocaleService, this.locale);
		services.registerInstance(IQuickInputService, this.quickInput);
		services.registerInstance(INotificationService, {
			error: (message: string) => {
				this.errors.push(message);
				return;
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
	private readonly installedCatalogs: LanguagePackCatalog[] = [...productLanguagePackCatalogs];
	public readonly onDidChange = this.changed.event;
	public readonly whenReady = Promise.resolve();
	private pendingFrenchCatalog = false;

	public get catalogs(): readonly LanguagePackCatalog[] {
		return this.installedCatalogs;
	}

	public async getInstalledLanguages(): Promise<ILanguagePackItem[]> {
		return this.installedCatalogs.map(catalog => ({ id: catalog.locale, label: catalog.localizedLanguageName }));
	}

	public async getBuiltInExtensionTranslationsUri(): Promise<undefined> {
		return undefined;
	}

	public queueFrenchCatalog(): void {
		this.pendingFrenchCatalog = true;
	}

	public async refresh(): Promise<void> {
		if (!this.pendingFrenchCatalog) {
			return;
		}
		this.pendingFrenchCatalog = false;
		this.installedCatalogs.push({
			schemaVersion: 1,
			locale: 'fr',
			languageName: 'French',
			localizedLanguageName: 'Français',
			catalogVersion: productLanguagePackCatalogs[0]!.catalogVersion,
			bundles: { 'ash.settings': { 'displayLanguage.title': 'Langue d’affichage' } },
		});
		this.changed.fire();
	}
}

class TestQuickInputService implements IQuickInputService {
	readonly quickAccess = quickInputServiceTestControls.quickAccess;
	readonly onShow = quickInputServiceTestControls.onShow;
	readonly onHide = quickInputServiceTestControls.onHide;
	readonly currentQuickInput = undefined;
	focus = quickInputServiceTestControls.focus;
	toggle = quickInputServiceTestControls.toggle;
	setAlignment = quickInputServiceTestControls.setAlignment;
	navigate = quickInputServiceTestControls.navigate;
	accept = quickInputServiceTestControls.accept;
	cancel = quickInputServiceTestControls.cancel;

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
	readonly type = QuickInputType.QuickPick;
	activeItems: readonly TItem[] = [];
	focus(): void {}
	toggle(): void {}
	accept(inBackground = false): void {
		this.selectedItems = this.activeItems;
		this.accepted.fire({ inBackground });
	}

	canSelectMany = false;
	selectedItems: readonly TItem[] = [];
	readonly onDidChangeSelection = QuickPickTestEvent.None;
	sortByLabel = true;
	private readonly accepted = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	private readonly changed = this._register(new Emitter<string>());
	private readonly hidden = this._register(new Emitter<void>());
	private readonly itemsChanged = this._register(new Emitter<void>());
	private currentItems: readonly TItem[] = [];
	public readonly onDidAccept = this.accepted.event;
	public readonly onDidChangeValue = this.changed.event;
	public readonly onDidHide = this.hidden.event;
	public readonly onDidChangeItems = this.itemsChanged.event;
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

	public chooseItem(item: TItem): void {
		this.selectedItems = [item];
		this.accepted.fire({ inBackground: false });
	}

	public setQuery(value: string): void {
		this.value = value;
		this.changed.fire(value);
	}

	public show(): void {}
	public hide(): void {
		this.hidden.fire();
	}
}

function nextPreferenceChange(configuration: InMemoryConfigurationService): Promise<void> {
	return new Promise(resolve => {
		const listener = configuration.onDidChangeConfiguration(() => {
			listener.dispose();
			resolve();
		});
	});
}
