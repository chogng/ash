import { ActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import type { IAction } from '../../../base/common/actions.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { ActionWidgetDropdown, type IActionWidgetDropdownOptions } from '../../actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';

/** ActionBar presentation; the dropdown owns trigger input and menu visibility. */
export class ActionWidgetDropdownActionViewItem extends ActionViewItem {
	protected element!: HTMLElement;
	private dropdown!: ActionWidgetDropdown;

	constructor(action: IAction, private readonly actionWidgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'ariaLabel' | 'labelRenderer'>, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		this.dropdown = this._register(this.instantiationService.createInstance(ActionWidgetDropdown, container, {
			...this.actionWidgetOptions,
			label: this.action.label,
			ariaLabel: this.action.tooltip,
			labelRenderer: (element: HTMLElement) => this.renderLabel(element),
		}));
		this.element = this.dropdown.element;
		this._register(this.dropdown.onDidChangeVisibility(() => this.setTabbable(true)));
		this.setupHover(this.element, this.action.tooltip);
		this.updateEnabled();
	}

	protected renderLabel(element: HTMLElement): IDisposable | null {
		if (this.action.icon) { appendIcon(this.action.icon, element.querySelector<HTMLElement>('.ash-icon-label-icon')!); }
		return null;
	}

	protected updateEnabled(): void {
		this.element.classList.toggle('disabled', !this.action.enabled);
		this.dropdown.setEnabled(this.action.enabled);
	}

	public override focus(): void { this.element.focus(); }

	public override setTabbable(tabbable: boolean): void {
		this.element.tabIndex = tabbable && this.action.enabled ? 0 : -1;
	}

	public show(): void { this.dropdown.show(); }

	public hide(): void { this.dropdown.hide(); }
}
