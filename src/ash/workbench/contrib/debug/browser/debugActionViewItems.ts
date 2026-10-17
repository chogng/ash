import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { ActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IAction } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { IDebugService, type IDebugConfiguration, type IDebugCompound } from '../common/debug.js';
import { debugStart } from './debugIcons.js';

/** Title action presentation; the configuration manager owns catalog and selection. */
export class StartDebugActionViewItem extends ActionViewItem {
	private startButton: HTMLButtonElement | undefined;
	private dropdown: ActionWidgetDropdown | undefined;
	private label: HTMLElement | undefined;
	private tabbable = false;

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		@IDebugService private readonly debug: IDebugService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(action, options);
		const manager = debug.getConfigurationManager();
		this._register(manager.onDidSelectConfiguration(() => this.update()));
		this._register(debug.onDidChangeConfigurations(() => { this.dropdown?.hide(); this.update(); }));
		this._register(debug.onDidChangeSession(() => this.update()));
	}

	override render(container: HTMLElement): void {
		// This action contains two controls, so the toolbar's fixed icon slot does not apply.
		container.classList.remove('icon');
		container.classList.add('ash-debug-launch-start');
		const start = this.createButton(container, {
			label: this.action.label,
			title: this.action.tooltip,
			icon: debugStart,
			iconOnly: true,
			onClick: () => {
				void Promise.resolve().then(() => this.action.run()).catch(error => {
					if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error.message : String(error));
				});
			},
		});
		this.startButton = start.domNode;
		const label = this.label = h(container.ownerDocument, 'span');
		label.className = 'ash-debug-configuration-label';
		const dropdown = this.dropdown = this._register(this.instantiationService.createInstance(ActionWidgetDropdown, container, {
			label: localize('debug.configuration', 'Debug configuration'),
			ariaLabel: localize('debug.configuration', 'Debug configuration'),
			labelRenderer: (element: HTMLElement) => {
				element.replaceChildren(label);
				appendIcon(Lxicon.chevronDown, element);
				return null;
			},
			actionProvider: { getActions: () => this.configurationActions() },
			listOptions: {
				showFilter: true,
				filterPlaceholder: localize('debug.searchConfigurations', 'Search configurations'),
				focusFilterOnOpen: true,
				ariaLabel: localize('debug.configuration', 'Debug configuration'),
			},
		}));
		dropdown.element.classList.add('ash-debug-configuration');
		this._register(addDisposableListener(container, 'keydown', event => {
			if (event.isComposing) return;
			if (event.key === 'ArrowRight' && event.target === this.startButton) {
				stopEvent(event);
				dropdown.element.focus();
			} else if (event.key === 'ArrowLeft' && event.target === dropdown.element) {
				stopEvent(event);
				this.startButton?.focus();
			}
		}));
		this.update();
	}

	override focus(): void {
		if (this.startButton?.disabled) this.dropdown?.element.focus();
		else this.startButton?.focus();
	}

	blur(): void { this.dropdown?.hide(); }

	override setTabbable(tabbable: boolean): void {
		this.tabbable = tabbable;
		if (this.startButton) this.startButton.tabIndex = tabbable && !this.startButton.disabled ? 0 : -1;
		if (this.dropdown) this.dropdown.element.tabIndex = tabbable && this.startButton?.disabled ? 0 : -1;
	}

	private configurationActions(): IAction[] {
		const manager = this.debug.getConfigurationManager();
		return manager.getAllConfigurations().map(configuration => {
			const label = this.configurationLabel(configuration);
			return {
				id: configuration.id, label, tooltip: label, enabled: true,
				checked: configuration.id === manager.selectedConfiguration?.id,
				run: () => manager.selectConfiguration(configuration)
			};
		});
	}

	private configurationLabel(configuration: IDebugConfiguration | IDebugCompound): string {
		// Folder names only help when otherwise identical choices belong to different folders.
		const needsFolder = configuration.workspaceFolderName && this.debug.getConfigurationManager().getAllConfigurations().some(
			candidate => candidate.name === configuration.name && candidate.dirId !== configuration.dirId
		);
		const label = needsFolder ? `${configuration.name} — ${configuration.workspaceFolderName}` : configuration.name;
		return 'configurations' in configuration ? localize('debug.compound', '{0} (compound)', label) : label;
	}

	private update(): void {
		if (!this.startButton || !this.dropdown || !this.label) return;
		const selected = this.debug.getConfigurationManager().selectedConfiguration;
		const label = selected ? this.configurationLabel(selected) : localize('debug.noConfigurations', 'No debug configurations');
		this.label.textContent = label;
		this.dropdown.element.title = label;
		this.dropdown.element.setAttribute('aria-label', localize('debug.configurationSelected', 'Debug configuration: {0}', label));
		this.dropdown.setEnabled(selected !== undefined);
		this.startButton.disabled = !selected || this.debug.session?.state === 'starting';
		this.setTabbable(this.tabbable);
	}
}
