import { ActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IManagedHover } from '../../../base/browser/ui/hover/hoverDelegate.js';
import type { IAction } from '../../../base/common/actions.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { ActionWidgetDropdown, type IActionWidgetDropdownOptions } from '../../actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';

/** ActionBar presentation; the dropdown owns trigger input and menu visibility. */
export class ActionWidgetDropdownActionViewItem extends ActionViewItem {
	protected element!: HTMLElement;
	private dropdown!: ActionWidgetDropdown;
	private hover: IManagedHover | undefined;

	constructor(action: IAction, private readonly actionWidgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'ariaLabel' | 'labelRenderer'>, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		this.dropdown = this._register(this.instantiationService.createInstance(ActionWidgetDropdown, container, {
			...this.actionWidgetOptions,
			label: this.action.label,
			ariaLabel: this.action.tooltip,
			buttonOptions: {
				icon: this.action.icon,
				...this.actionWidgetOptions.buttonOptions,
			},
			labelRenderer: (element: HTMLElement) => this.renderLabel(element),
		}));
		this.element = this.dropdown.element;
		this._register(this.dropdown.onDidChangeVisibility(() => this.setTabbable(true)));
		this.hover = this.setupHover(this.element, this.action.tooltip);
		this.updateEnabled();
	}

	protected renderLabel(_element: HTMLElement): IDisposable | null {
		return null;
	}

	protected updateEnabled(): void {
		this.element.classList.toggle('disabled', !this.action.enabled);
		this.dropdown.setEnabled(this.action.enabled);
	}

	protected refreshActionLabel(): void {
		this.dropdown.setIcon(this.action.icon);
		this.dropdown.setLabel(this.action.label);
		this.element.setAttribute('aria-label', this.action.tooltip);
		this.hover?.update(this.action.tooltip);
	}

	public override focus(): void { this.element.focus(); }

	public override setTabbable(tabbable: boolean): void {
		this.element.tabIndex = tabbable && this.action.enabled ? 0 : -1;
	}

	public show(): void { this.dropdown.show(); }

	public hide(): void { this.dropdown.hide(); }
}
