import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService, type IConfigurationChangeEvent } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MenuSettings, TitleBarSetting, resolveContextMenuStyle, type MenuStyleConfiguration, type TitleBarStyleConfiguration } from '../../../../platform/window/common/window.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';

export class SettingsChangeRelauncher extends Disposable {
	static readonly ID = 'workbench.contrib.settingsChangeRelauncher';

	private startupTitleBarStyle: TitleBarStyleConfiguration | undefined;
	private readonly ready: Promise<void>;
	private readonly startupMenuStyle: 'custom' | 'system';
	private titleBarStyle: TitleBarStyleConfiguration;
	private menuStyle: 'custom' | 'system';
	private confirming = false;
	private checkTitleBarAfterReady = true;
	private checkMenuAfterReady = true;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IHostService private readonly host: IHostService,
		@INativeHostService windowHost: INativeHostApi,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super();
		this.titleBarStyle = this.configuration.getValue<TitleBarStyleConfiguration>(TitleBarSetting.TitleBarStyle);
		this.menuStyle = this.readMenuStyle(this.titleBarStyle);
		this.startupMenuStyle = contextMenus.contextMenuStyle;
		this._register(configuration.onDidChangeConfiguration(event => this.onConfigurationChange(event)));
		this.ready = windowHost
			.getTitleBarStyle()
			.then(titleBarStyle => {
				if (this._store.isDisposed) return;
				this.startupTitleBarStyle = titleBarStyle;
				// Settings can change before this contribution is created or while Main answers.
				if (this.requiresRestart(this.checkTitleBarAfterReady, this.checkMenuAfterReady)) this.checkForRestart();
			})
			.catch(onUnexpectedError);
	}

	onWorkspaceRestored(): Promise<void> {
		return this.ready;
	}

	private readMenuStyle(titleBarStyle: TitleBarStyleConfiguration): 'custom' | 'system' {
		return resolveContextMenuStyle(this.configuration.getValue<MenuStyleConfiguration>(MenuSettings.MenuStyle), titleBarStyle, isMacintosh ? 'macos' : 'desktop');
	}

	private onConfigurationChange(event: IConfigurationChangeEvent): void {
		if (!event.affectsConfiguration(TitleBarSetting.TitleBarStyle) && !event.affectsConfiguration(MenuSettings.MenuStyle)) return;
		const titleBarStyle = this.configuration.getValue<TitleBarStyleConfiguration>(TitleBarSetting.TitleBarStyle);
		const menuStyle = this.readMenuStyle(titleBarStyle);
		// macOS switches context menu implementations immediately; other desktop hosts snapshot it at startup.
		const titleBarChanged = titleBarStyle !== this.titleBarStyle;
		const menuChanged = !isMacintosh && menuStyle !== this.menuStyle;
		this.titleBarStyle = titleBarStyle;
		this.menuStyle = menuStyle;
		if (titleBarChanged || menuChanged) {
			if (this.startupTitleBarStyle === undefined) {
				if (titleBarChanged) this.checkTitleBarAfterReady = event.source !== ConfigurationTarget.DEFAULT;
				if (menuChanged) this.checkMenuAfterReady = event.source !== ConfigurationTarget.DEFAULT;
			}
			if (event.source !== ConfigurationTarget.DEFAULT) this.checkForRestart();
		}
	}

	private checkForRestart(): void {
		if (this.requiresRestart() && this.host.hasFocus && !this.confirming) {
			void this.confirmRestart().catch(onUnexpectedError);
		}
	}

	private requiresRestart(checkTitleBar = true, checkMenu = true): boolean {
		if (this.startupTitleBarStyle === undefined) return false;
		const titleBarStyle = this.configuration.getValue<TitleBarStyleConfiguration>(TitleBarSetting.TitleBarStyle);
		return (checkTitleBar && titleBarStyle !== this.startupTitleBarStyle) || (checkMenu && !isMacintosh && this.readMenuStyle(titleBarStyle) !== this.startupMenuStyle);
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
			if (confirmed && !this._store.isDisposed && this.requiresRestart()) await this.host.restart();
		} finally {
			this.confirming = false;
		}
	}
}

registerWorkbenchContribution(SettingsChangeRelauncher.ID, WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(SettingsChangeRelauncher));
