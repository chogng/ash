import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { ITreeItem } from '../../../common/views.js';

/** Reports user changes; the data provider owns their authoritative state. */
export class CheckboxStateHandler extends Disposable {
	private readonly changed = this._register(new Emitter<ITreeItem[]>());
	public readonly onDidChangeCheckboxState = this.changed.event;

	public setCheckboxState(node: ITreeItem): void {
		this.changed.fire([node]);
	}
}

export class TreeItemCheckbox extends Disposable {
	public static readonly checkboxClass = 'ash-tree-item-checkbox';
	private readonly checkbox: Checkbox;
	private node: ITreeItem | undefined;

	constructor(container: HTMLElement, checkboxStateHandler: CheckboxStateHandler) {
		super();
		this.checkbox = this._register(new Checkbox(container, defaultCheckboxStyles));
		this.checkbox.element.classList.add(TreeItemCheckbox.checkboxClass);
		this._register(addDisposableListener(this.checkbox.element, 'click', event => event.stopPropagation()));
		this._register(addDisposableListener(this.checkbox.input, 'keydown', event => {
			if (event.key === ' ' || event.key === 'Enter') { event.stopPropagation(); }
		}));
		this._register(this.checkbox.onDidChange(checked => {
			if (!this.node?.checkbox) { return; }
			this.node.checkbox.isChecked = checked;
			checkboxStateHandler.setCheckboxState(this.node);
		}));
	}

	public render(node: ITreeItem): void {
		this.node = node;
		this.checkbox.element.hidden = !node.checkbox;
		this.checkbox.checked = node.checkbox?.isChecked ?? false;
		this.checkbox.setAriaLabel(node.checkbox?.accessibilityInformation?.label ?? node.label?.label ?? node.handle);
		this.checkbox.input.title = node.checkbox?.tooltip ?? '';
	}
}
