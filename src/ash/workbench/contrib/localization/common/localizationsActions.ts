import { localize2, localize } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILanguagePackService, type ILanguagePackItem } from '../../../../platform/languagePacks/common/languagePacks.js';
import {
	IExtensionManagementService,
	OPEN_EXTENSIONS_COMMAND_ID,
	type ExtensionsPackageSummary,
} from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ILocaleService } from '../../../services/localization/common/locale.js';
import { preinstalledLanguagePacks } from '../../../services/localization/common/localizationCatalogs.js';

interface InstalledLanguageItem extends IQuickPickItem {
	readonly kind: 'locale';
	readonly locale: ILanguagePackItem;
}

interface AvailablePackageItem extends IQuickPickItem {
	readonly kind: 'package';
	readonly languagePack: ExtensionsPackageSummary;
}

interface BrowseLanguagesItem extends IQuickPickItem {
	readonly kind: 'browse';
}

type LanguageItem = InstalledLanguageItem | AvailablePackageItem | BrowseLanguagesItem;

export class ConfigureDisplayLanguageAction extends Action2 {
	public static readonly ID = 'workbench.action.configureLocale';

	constructor() {
		super({
			id: ConfigureDisplayLanguageAction.ID,
			title: localize2({ bundle: 'ash.settings', key: 'displayLanguage.configure' }, 'Configure Display Language'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const languagePacks = accessor.get(ILanguagePackService);
		const extensionManagement = accessor.get(IExtensionManagementService);
		const localeService = accessor.get(ILocaleService);
		const notifications = accessor.get(INotificationService);
		const installedLanguages = await languagePacks.getInstalledLanguages();
		const picker = accessor.get(IQuickInputService).createQuickPick<LanguageItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize({ bundle: 'ash.settings', key: 'displayLanguage.choose' }, 'Select Display Language');
		picker.ariaLabel = picker.placeholder;

		let searchRevision = 0;
		let closed = false;
		const installedItems = (): InstalledLanguageItem[] => installedLanguages.map(locale => ({
			kind: 'locale',
			locale,
			label: locale.label,
			description: locale.id === localeService.locale
				? localize({ bundle: 'ash.settings', key: 'displayLanguage.current' }, 'Current')
				: locale.description,
		}));
		const browseItem: BrowseLanguagesItem = {
			kind: 'browse',
			label: localize({ bundle: 'ash.settings', key: 'displayLanguage.installMore' }, 'Install more languages from Extensions'),
		};
		const search = async (query: string): Promise<void> => {
			const revision = ++searchRevision;
			if (!query.trim()) {
				picker.items = [...installedItems(), browseItem];
				return;
			}
			try {
				const [packages, installations] = await Promise.all([
					extensionManagement.search(query.trim(), { packageType: 'localization', limit: 30 }),
					extensionManagement.listInstalled(),
				]);
				if (closed || revision !== searchRevision) {
					return;
				}
				const installed = new Set([
					...preinstalledLanguagePacks,
					...installations.filter(installation => installation.state === 'installed').map(installation => installation.package),
				].map(pack => `${pack.id}\0${pack.version}`));
				picker.items = [
					...installedItems(),
					...packages.filter(pack => !installed.has(`${pack.id}\0${pack.version}`)).map((languagePack): AvailablePackageItem => ({
						kind: 'package',
						languagePack,
						label: languagePack.displayName,
						description: localize({ bundle: 'ash.settings', key: 'displayLanguage.installPack' }, 'Install language pack'),
					})),
					browseItem,
				];
			} catch (error) {
				if (!closed && revision === searchRevision) {
					notifications.error(localize(
						{ bundle: 'ash.settings', key: 'displayLanguage.searchFailed' },
						'Could not search language packs: {0}',
						String(error),
					));
				}
			}
		};

		picker.items = [...installedItems(), browseItem];
		disposables.add(picker.onDidChangeValue(query => { void search(query); }));
		disposables.add(picker.onDidAccept(item => {
			picker.hide();
			void (async () => {
				if (item.kind === 'browse') {
					await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { capabilityKind: 'localization' });
					return;
				}
				if (item.kind === 'locale') {
					await localeService.setLocale(item.locale);
					return;
				}
				const previousLocales = new Set((await languagePacks.getInstalledLanguages()).map(locale => locale.id));
				await extensionManagement.install(item.languagePack.id, item.languagePack.version);
				await languagePacks.refresh();
				const installedLocale = (await languagePacks.getInstalledLanguages()).find(locale => !previousLocales.has(locale.id));
				if (!installedLocale) {
					throw new Error(localize(
						{ bundle: 'ash.settings', key: 'displayLanguage.noLocale' },
						'The installed package contains no new display language.',
					));
				}
				await localeService.setLocale(installedLocale);
			})().catch(error => {
				notifications.error(localize(
					{ bundle: 'ash.settings', key: 'displayLanguage.changeFailed' },
					'Could not change display language: {0}',
					String(error),
				));
			});
		}));
		disposables.add(picker.onDidHide(() => {
			closed = true;
			disposables.dispose();
		}));
		picker.show();
	}
}

export class ClearDisplayLanguageAction extends Action2 {
	public static readonly ID = 'workbench.action.clearLocalePreference';

	constructor() {
		super({
			id: ClearDisplayLanguageAction.ID,
			title: localize2({ bundle: 'ash.settings', key: 'displayLanguage.clearPreference' }, 'Clear Display Language Preference'),
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ILocaleService).clearLocalePreference();
	}
}
