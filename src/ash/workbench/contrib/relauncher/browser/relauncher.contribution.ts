import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService, type IConfigurationChangeEvent } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MenuSettings, TitleBarSetting, resolveContextMenuStyle, type MenuStyleConfiguration, type TitleBarStyleConfiguration } from '../../../../platform/window/common/window.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';

export class SettingsChangeRelauncher extends Disposable {
	static readonly ID = 'workbench.contrib.settingsChangeRelauncher';

	private titleBarStyle: TitleBarStyleConfiguration;
	private menuStyle: 'custom' | 'system';
	private confirming = false;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IHostService private readonly host: IHostService,
	) {
		super();
		this.titleBarStyle = this.configuration.getValue<TitleBarStyleConfiguration>(TitleBarSetting.TitleBarStyle);
		this.menuStyle = this.readMenuStyle(this.titleBarStyle);
		this._register(configuration.onDidChangeConfiguration(event => this.onConfigurationChange(event)));
	}

	private readMenuStyle(titleBarStyle: TitleBarStyleConfiguration): 'custom' | 'system' {
		return resolveContextMenuStyle(this.configuration.getValue<MenuStyleConfiguration>(MenuSettings.MenuStyle), titleBarStyle, isMacintosh ? 'macos' : 'desktop');
	}

	private onConfigurationChange(event: IConfigurationChangeEvent): void {
		if (!event.affectsConfiguration(TitleBarSetting.TitleBarStyle) && !event.affectsConfiguration(MenuSettings.MenuStyle)) return;
		const titleBarStyle = this.configuration.getValue<TitleBarStyleConfiguration>(TitleBarSetting.TitleBarStyle);
		const menuStyle = this.readMenuStyle(titleBarStyle);
		// macOS switches context menu implementations immediately; other desktop hosts snapshot it at startup.
		const requiresRestart = titleBarStyle !== this.titleBarStyle || (!isMacintosh && menuStyle !== this.menuStyle);
		this.titleBarStyle = titleBarStyle;
		this.menuStyle = menuStyle;
		if (requiresRestart && event.source !== ConfigurationTarget.DEFAULT && this.host.hasFocus && !this.confirming) {
			void this.confirmRestart().catch(onUnexpectedError);
		}
	}

	private async confirmRestart(): Promise<void> {
		this.confirming = true;
		try {
			const { confirmed } = await this.dialogs.confirm({
				message: localize({ bundle: 'ash', key: 'relauncher.restartMessage' }, 'A setting has changed that requires a restart to take effect.'),
				detail: localize({ bundle: 'ash', key: 'relauncher.restartDetail' }, 'Restart Ash to apply the new window appearance.'),
				primaryButton: localize({ bundle: 'ash', key: 'relauncher.restartNow' }, 'Restart now'),
				cancelButton: localize({ bundle: 'ash', key: 'relauncher.restartLater' }, 'Later'),
			});
			if (confirmed && !this._store.isDisposed) await this.host.restart();
		} finally {
			this.confirming = false;
		}
	}
}

registerWorkbenchContribution(SettingsChangeRelauncher.ID, WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(SettingsChangeRelauncher));
