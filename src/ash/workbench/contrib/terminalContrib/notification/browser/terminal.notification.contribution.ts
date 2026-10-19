import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ITerminalLogService, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalService, type ITerminalContribution, type IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalOscNotificationsSettingId } from '../common/terminalNotificationConfiguration.js';
import { TerminalNotificationHandler } from './terminalNotificationHandler.js';

/** The screen owns its parser; lease changes retire every notification and its callbacks. */
class TerminalOscNotificationsContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.oscNotifications';
	private readonly handler: TerminalNotificationHandler;
	private screen: IXtermTerminal | undefined;

	constructor(
		private readonly context: ITerminalContributionContext,
		@IConfigurationService configuration: IConfigurationService,
		@INotificationService notifications: INotificationService,
		@IHostService host: IHostService,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
		@ITerminalEditorService private readonly editors: ITerminalEditorService,
		@ITerminalLogService log: ITerminalLogService,
	) {
		super();
		const instance = context.instance;
		this.handler = this._register(new TerminalNotificationHandler({
			isEnabled: () => !this.isDisposed && !instance.isReadOnly && instance.state === 'running'
				&& configuration.getValue<boolean>(TerminalOscNotificationsSettingId.EnableNotifications) !== false,
			isWindowFocused: () => host.hasFocus,
			isTerminalVisible: () => !!this.screen?.element.isConnected && this.screen.element.getClientRects().length > 0,
			focusTerminal: () => { void this.focus().catch(onUnexpectedError); },
			notify: notification => notifications.notify(notification),
			updateEnableNotifications: value => configuration.updateValue(TerminalOscNotificationsSettingId.EnableNotifications, value),
			logWarn: message => log.warn(message),
			writeToProcess: data => {
				if (!this.isDisposed && terminals.instances.includes(instance) && instance.state === 'running' && !instance.isReadOnly) {
					void instance.sendText(data, false).catch(error => log.warn('Could not deliver an OSC 99 terminal reply', error));
				}
			},
		}));
		this._register(instance.onDidChangeState(() => this.handler.clear()));
		this._register(instance.onDidExit(() => this.handler.clear()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(TerminalOscNotificationsSettingId.EnableNotifications)) this.handler.clear();
		}));
	}

	xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		const parser = screen.raw.parser.registerOscHandler(99, data => this.handler.handleSequence(data));
		this._register(toDisposable(() => parser.dispose()));
	}

	private async focus(): Promise<void> {
		const instance = this.context.instance;
		if (this.isDisposed || !this.terminals.instances.includes(instance)) return;
		this.terminals.setActiveInstance(instance);
		if (instance.target === TerminalLocation.Editor) await this.editors.openEditor(instance);
		else await this.groups.showPanel(true);
		if (!this.isDisposed && !this.screen?.isDisposed) this.screen?.focus();
	}
}

registerTerminalContribution(TerminalOscNotificationsContribution.ID, TerminalOscNotificationsContribution);
