import type { IAction } from '../../../base/common/actions.js';
import type { IQuickInputButton } from '../common/quickInput.js';
import { addDisposableListener, h, stopEvent } from '../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../base/browser/ui/iconlabel/iconLabels.js';
import { parseLinkedText } from '../../../base/common/linkedText.js';
import type { DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';

/** Keep button state on its descriptor so rebuilding a toolbar cannot reset a toggle. */
export function quickInputButtonToAction(button: IQuickInputButton, id: string, run: (...args: readonly unknown[]) => unknown): IAction {
	return {
		id,
		label: button.toggle ? button.tooltip ?? '' : '',
		tooltip: button.toggle ? '' : button.tooltip ?? '',
		class: [button.iconClass, button.iconPath ? 'ash-quick-input-button-image' : undefined, button.alwaysVisible ? 'always-visible' : undefined].filter(Boolean).join(' ') || undefined,
		enabled: true,
		get checked() { return button.toggle?.checked; },
		run: (...args) => {
			if (button.toggle) button.toggle.checked = !button.toggle.checked;
			return run(...args);
		},
	};
}

export function quickInputButtonsToActionArrays(
	buttons: readonly IQuickInputButton[],
	idPrefix: string,
	onTrigger: (button: IQuickInputButton, context?: unknown) => unknown,
): { primary: IAction[]; secondary: IAction[]; } {
	const primary: IAction[] = [];
	const secondary: IAction[] = [];
	buttons.forEach((button, index) => {
		const action = quickInputButtonToAction(button, `${idPrefix}-${index}`, context => onTrigger(button, context));
		// A caption belongs to the toolbar/menu presentation, rather than the raw button action.
		(button.secondary ? secondary : primary).push(button.label ? { ...action, label: button.label, get checked() { return action.checked; } } : action);
	});
	return { primary, secondary };
}

/** Native anchors provide pointer/touch activation; the caller owns opening and listener lifetime. */
export function renderQuickInputDescription(description: string, container: HTMLElement, actionHandler: { callback: (content: string) => void; disposables: DisposableStore; }): void {
	container.replaceChildren();
	for (const node of parseLinkedText(description).nodes) {
		if (typeof node === 'string') {
			const text = h(container.ownerDocument, 'span');
			renderLabelWithIcons(text, node);
			container.append(text);
			continue;
		}
		const link = h(container.ownerDocument, 'a');
		link.href = node.href;
		link.textContent = node.label;
		link.title = node.title ?? (node.href.startsWith('command:')
			? localize('quickInput.executeCommand', "Click to execute command '{0}'", node.href.slice('command:'.length)) : node.href);
		link.tabIndex = 0;
		const open = (event: Event): void => { stopEvent(event); actionHandler.callback(node.href); };
		actionHandler.disposables.add(addDisposableListener(link, 'click', open));
		actionHandler.disposables.add(addDisposableListener(link, 'keydown', event => {
			if (!event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'Enter' || event.key === ' ')) open(event);
		}));
		container.append(link);
	}
}
