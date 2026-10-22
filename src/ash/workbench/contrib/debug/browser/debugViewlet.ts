import { h, type IDimension } from '../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { DebugToolBar } from './debugToolBar.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { ActionViewItem, ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../browser/panecomposite.js';
import { localize } from '../../../../nls.js';
import { IDebugService, START_DEBUG_COMMAND_ID, CONTEXT_DEBUG_UX, CONTEXT_BREAKPOINTS_EXIST } from '../common/debug.js';
import { DEBUG_CONFIGURE_COMMAND_ID } from './debugCommands.js';
import { StartDebugActionViewItem } from './debugActionViewItems.js';
import { debugConfigure, debugStart } from './debugIcons.js';
import './media/debugViewlet.css';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';

/** Owns title actions and inline controls; the view framework owns inspection panes and layout. */
export class DebugViewPaneContainer extends PaneComposite {
	private readonly chrome: HTMLElement;
	private readonly resetConditions: () => void;
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
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		// Publish presentation conditions before the framework constructs active views.
		const ux = CONTEXT_DEBUG_UX.bindTo(contextKeys);
		const breakpoints = CONTEXT_BREAKPOINTS_EXIST.bindTo(contextKeys);
		let hasDebugged = debug.session !== undefined;
		const updateConditions = (): void => {
			hasDebugged ||= debug.session !== undefined;
			contextKeys.bufferChangeEvents(() => {
				ux.set(hasDebugged || debug.configurations.length + debug.compounds.length > 0 ? 'default' : 'simple');
				breakpoints.set(debug.breakpoints.length + debug.functionBreakpoints.length + debug.dataBreakpoints.length + debug.instructionBreakpoints.length > 0);
			});
		};
		updateConditions();
		super(container, { ...options, mergeViewWithContainerWhenSingleView: true }, storage, theme, menus, configuration, instantiation, contextKeys);
		this.resetConditions = () => { ux.reset(); breakpoints.reset(); };
		this._register(debug.onDidChangeConfigurations(updateConditions));
		this._register(debug.onDidChangeSession(updateConditions));
		this._register(debug.onDidChangeBreakpoints(updateConditions));
		this.element.classList.add('ash-debug-viewlet', 'ash-debug');
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Debug);
		if (hint) this.element.setAttribute('aria-description', hint);
		this.chrome = h(container.ownerDocument, 'div');
		this.chrome.className = 'ash-debug-chrome';
		this.element.prepend(this.chrome);
		this._register(instantiation.createInstance(DebugToolBar, this.chrome));
		const relayout = (): void => {
			if (this.element.clientHeight > 0) this.layout({ width: this.element.clientWidth, height: this.element.clientHeight });
		};
		this._register(observeElementSize(this.chrome, relayout));
		void debug.refresh().catch(error => {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error.message : String(error));
		});
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

	override layout(dimension: IDimension): void {
		super.layout({ width: dimension.width, height: Math.max(0, dimension.height - (this.chrome?.offsetHeight ?? 0)) });
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

	protected override disposeCore(): void {
		// Tear down view/model listeners before changing the conditions that create panes.
		super.disposeCore();
		this.resetConditions();
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
