import './iconSelectBox.css';
import '../../../../base/browser/ui/button/button.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { IconSelectBox, type IIconSelectBoxOptions } from '../../../../base/browser/ui/icons/iconSelectBox.js';
import { Emitter } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

interface IWorkbenchIconSelectBoxOptions extends IIconSelectBoxOptions {
	readonly showResetButton?: boolean;
}

/** Adds the Workbench reset action to the shared icon grid. */
export class WorkbenchIconSelectBox extends IconSelectBox {
	private readonly reset = this._register(new Emitter<void>());
	readonly onDidReset = this.reset.event;

	constructor(options: IWorkbenchIconSelectBoxOptions, container: HTMLElement) {
		const document = container.ownerDocument;
		super(options, document);
		container.append(this.domNode);
		if (options.showResetButton) {
			const button = h(document, 'button', { className: 'ash-button ash-button-secondary', attributes: { type: 'button' } });
			button.textContent = localize('iconPicker.resetIcon', 'Reset icon');
			const footer = h(document, 'div', { className: 'ash-icon-select-reset' }, button);
			container.append(footer);
			this._register(toDisposable(() => footer.remove()));
			this._register(addDisposableListener(button, 'click', () => this.reset.fire()));
		}
	}
}
