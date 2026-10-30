import { InputBox } from '../../../browser/ui/inputbox/inputbox.js';
import { DisposableStore } from '../../../common/lifecycle.js';

const resources = new DisposableStore();
for (const options of [
	{ ariaLabel: 'Default' },
	{ ariaLabel: 'Disabled selection', selectOnFocus: false },
	{ ariaLabel: 'Select text', selectOnFocus: true },
	{ ariaLabel: 'Select number', selectOnFocus: true, type: 'number' as const },
	{ ariaLabel: 'Select multiline', selectOnFocus: true, flexibleHeight: true },
]) {
	const input = resources.add(new InputBox(document.body, { presentation: 'field', ...options }));
	input.value = options.type === 'number' ? '100' : 'D4D4D4';
}
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
