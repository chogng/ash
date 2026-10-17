import type { IAction } from '../../../../base/common/actions.js';
import type { ActionViewItem, ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../browser/parts/views/paneComposite.js';
import { localize } from '../../../../nls.js';
import { IDebugService, START_DEBUG_COMMAND_ID } from '../common/debug.js';
import { DEBUG_CONFIGURE_COMMAND_ID } from './debugCommands.js';
import { StartDebugActionViewItem } from './debugActionViewItems.js';
import { debugConfigure, debugStart } from './debugIcons.js';
import './media/debugViewlet.css';

/** The Debug container owns title actions; its pane retains inspection and welcome content. */
export class DebugViewPaneContainer extends PaneComposite {
	private readonly startAction: IAction;
	private readonly configureAction: IAction;
	private startItem: StartDebugActionViewItem | undefined;
	private readonly configurationRequest = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		container: HTMLElement,
		options: PaneCompositeOptions,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IDebugService private readonly debug: IDebugService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(container, { ...options, mergeViewWithContainerWhenSingleView: true }, storage, theme, menus);
		this.element.classList.add('ash-debug-viewlet');
		const startLabel = localize('debug.start', 'Start Debugging');
		this.startAction = {
			id: START_DEBUG_COMMAND_ID, label: startLabel, tooltip: startLabel, icon: debugStart, enabled: true,
			run: () => this.commands.executeCommand(START_DEBUG_COMMAND_ID, true)
		};
		const configureLabel = localize('debug.configure', 'Open launch.json');
		this.configureAction = {
			id: DEBUG_CONFIGURE_COMMAND_ID, label: configureLabel, tooltip: configureLabel, icon: debugConfigure, enabled: true,
			run: () => this.configure()
		};
		this._register(debug.onDidChangeConfigurations(() => this.updateTitleArea()));
		this._register(debug.onDidChangeSession(() => this.updateTitleArea()));
		this._register(workspace.onDidChangeWorkspace(() => this.updateTitleArea()));
	}

	override getActions(): readonly IAction[] {
		const hasConfigurations = this.debug.getConfigurationManager().getAllConfigurations().length > 0;
		return [
			...(hasConfigurations ? [this.startAction] : []),
			...(this.workspace.getWorkspace().folders.length > 0 ? [this.configureAction] : []),
			...super.getActions(),
		];
	}

	override getActionViewItem(action: IAction, options: ActionViewItemOptions): ActionViewItem | undefined {
		if (action.id !== START_DEBUG_COMMAND_ID) return super.getActionViewItem(action, options);
		return this.startItem = this.instantiation.createInstance(StartDebugActionViewItem, action, options);
	}

	override setVisible(visible: boolean): void {
		if (!visible) this.startItem?.blur();
		super.setVisible(visible);
	}

	override focus(): void {
		if (this.startItem && !this.startItem.isDisposed) this.startItem.focus();
		else super.focus();
	}

	private async configure(): Promise<void> {
		const controller = new AbortController();
		const lifetime = new DisposableStore();
		lifetime.add(toDisposable(() => controller.abort()));
		this.configurationRequest.value = lifetime;
		try {
			await this.commands.executeCommand(DEBUG_CONFIGURE_COMMAND_ID, undefined, false, controller.signal);
		} catch (error) {
			if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.configurationRequest.value === lifetime) this.configurationRequest.clear();
		}
	}
}
