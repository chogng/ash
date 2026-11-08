import { getActiveElement, h, isHTMLElement } from '../../../../base/browser/dom.js';
import { setAriaAttribute } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export interface IArtifactButton {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly enabled?: boolean;
	readonly pressed?: boolean;
	run(target: HTMLElement): void;
}

interface RenderedButton extends IDisposable {
	readonly element: HTMLDivElement;
	readonly button: Button;
	readonly description: HTMLParagraphElement;
	action: IArtifactButton;
}

/** Owns the buttons in an artifact action group and retains their identity across updates. */
export class ArtifactButtons extends Disposable {
	private readonly buttons = this._register(new DisposableMap<string, RenderedButton>());

	constructor(readonly element: HTMLElement) {
		super();
		element.setAttribute('role', 'group');
	}

	update(actions: readonly IArtifactButton[]): void {
		const document = this.element.ownerDocument;
		const focused = getActiveElement(document);
		const ids = new Set(actions.map(action => action.id));
		for (const id of this.buttons.keys()) {
			if (!ids.has(id)) this.buttons.deleteAndDispose(id);
		}

		let next = this.element.firstElementChild;
		for (const action of actions) {
			const entry = this.buttons.get(action.id) ?? this.buttons.set(action.id, this.createButton(action));
			if (entry.action.label !== action.label) entry.button.label = action.label;
			entry.action = action;
			entry.button.enabled = action.enabled !== false;
			setAriaAttribute(entry.button.domNode, 'pressed', action.pressed);
			entry.description.textContent = action.description ?? '';
			entry.description.hidden = action.description === undefined;
			setAriaAttribute(entry.button.domNode, 'describedby', action.description === undefined ? undefined : entry.description.id);

			if (entry.element !== next) this.element.insertBefore(entry.element, next);
			next = entry.element.nextElementSibling;
		}
		this.element.hidden = actions.length === 0;
		if (isHTMLElement(focused) && this.element.contains(focused) && getActiveElement(document) !== focused) {
			focused.focus({ preventScroll: true });
		}
	}

	private createButton(action: IArtifactButton): RenderedButton {
		const lifetime = new DisposableStore();
		const document = this.element.ownerDocument;
		const element = h(document, 'div', { className: 'ash-session-artifact-button' });
		const button = lifetime.add(new Button(element, { ...defaultButtonStyles, label: action.label, presentation: 'secondary' }));
		const description = h(document, 'p');
		description.id = createUuid();
		element.append(description);
		const entry = Object.assign(lifetime, { element, button, description, action });
		lifetime.add(button.onDidClick(() => {
			if (button.enabled) entry.action.run(button.domNode);
		}));
		lifetime.add(toDisposable(() => element.remove()));
		return entry;
	}
}
