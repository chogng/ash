import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { ContextViewFocusRestore } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { BrowserContextViewService } from '../../../browser/contextViewService.js';

const resources = new DisposableStore();
const container = document.querySelector('main')!;
const overlays = resources.add(new BrowserContextViewService(container));
const inside = h(document, 'button', {}, 'Inside overlay');
const dialog = resources.add(new Dialog(container, 'Modal', [], { buttonStyles: defaultButtonStyles, checkboxStyles: defaultCheckboxStyles, inputBoxStyles: defaultInputBoxStyles, dialogStyles: defaultDialogStyles, disableDefaultAction: true, renderBody: body => body.append(inside) }));
let count = 0;

for (const anchor of [inside, document.querySelector<HTMLButtonElement>('#outside')!]) {
	resources.add(addDisposableListener(anchor, 'click', () => {
		const action = h(document, 'button', {}, 'Overlay action');
		action.onclick = () => {
			document.querySelector('output')!.textContent = String(++count);
			overlays.hide();
		};
		overlays.show({ anchor, content: action, focusRestore: ContextViewFocusRestore.Previous });
		action.focus();
	}));
}
resources.add(addDisposableListener(document.querySelector('#open')!, 'click', () => { void dialog.show(); }));
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
