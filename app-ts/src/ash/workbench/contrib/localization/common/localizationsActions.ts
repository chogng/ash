import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacksService.js';
import type { LanguagePackInfo, LanguagePackPackage } from '../../../../platform/languagePacks/common/languagePacksService.js';
import { OPEN_MARKETPLACE_COMMAND_ID } from '../../../../platform/marketplace/common/marketplaceService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ILocaleService } from '../../../services/localization/common/locale.js';

interface InstalledLanguageItem extends IQuickPickItem {
	readonly kind: 'locale';
	readonly locale: LanguagePackInfo;
}

interface AvailablePackageItem extends IQuickPickItem {
	readonly kind: 'package';
	readonly languagePack: LanguagePackPackage;
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
			title: localizedString('ash.settings', 'displayLanguage.configure', 'Configure Display Language'),
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const languagePacks = accessor.get(ILanguagePackService);
		const localeService = accessor.get(ILocaleService);
		const notifications = accessor.get(INotificationService);
		const picker = accessor.get(IQuickInputService).createQuickPick<LanguageItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize({ bundle: 'ash.settings', key: 'displayLanguage.choose' }, 'Select Display Language');
		picker.ariaLabel = picker.placeholder;

		let searchRevision = 0;
		let closed = false;
		const installedItems = (): InstalledLanguageItem[] => languagePacks.availableLocales.map(locale => ({
			kind: 'locale',
			locale,
			label: locale.localizedLanguageName,
			description: locale.locale === localeService.locale
				? localize({ bundle: 'ash.settings', key: 'displayLanguage.current' }, 'Current')
				: locale.languageName,
		}));
		const browseItem: BrowseLanguagesItem = {
			kind: 'browse',
			label: localize({ bundle: 'ash.settings', key: 'displayLanguage.installMore' }, 'Install more languages from Marketplace'),
		};
		const search = async (query: string): Promise<void> => {
			const revision = ++searchRevision;
			if (!query.trim()) {
				picker.items = [...installedItems(), browseItem];
				return;
			}
			try {
				const packages = await languagePacks.search(query.trim(), 30);
				if (closed || revision !== searchRevision) {
					return;
				}
				picker.items = [
					...installedItems(),
					...packages.filter(languagePack => !languagePack.installed).map((languagePack): AvailablePackageItem => ({
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
					await accessor.get(ICommandService).executeCommand(OPEN_MARKETPLACE_COMMAND_ID, { capabilityKind: 'localization' });
					return;
				}
				if (item.kind === 'locale') {
					await localeService.setLocale({ id: item.locale.locale, label: item.locale.localizedLanguageName });
					return;
				}
				const previousLocales = new Set(languagePacks.availableLocales.map(locale => locale.locale));
				await languagePacks.install(item.languagePack.id, item.languagePack.version);
				const installedLocale = languagePacks.availableLocales.find(locale => !previousLocales.has(locale.locale));
				if (!installedLocale) {
					throw new Error(localize(
						{ bundle: 'ash.settings', key: 'displayLanguage.noLocale' },
						'The installed package contains no new display language.',
					));
				}
				await localeService.setLocale({ id: installedLocale.locale, label: installedLocale.localizedLanguageName });
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
			title: localizedString('ash.settings', 'displayLanguage.clearPreference', 'Clear Display Language Preference'),
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ILocaleService).clearLocalePreference();
	}
}
