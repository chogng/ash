import { h } from '../../../../base/browser/dom.js';
import { setAriaAttribute } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { ChatPillsWidget, createChatPillButton, type IChatPill } from '../../../../workbench/browser/chatPills.js';

export interface IArtifactButton {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly enabled?: boolean;
	readonly pressed?: boolean;
	run(target: HTMLElement): void;
}

/** Adds artifact descriptions and actions to the shared pill collection. */
export class ArtifactButtons extends Disposable {
	private readonly pills: ChatPillsWidget<IArtifactButton>;

	constructor(readonly element: HTMLElement) {
		super();
		element.setAttribute('role', 'group');
		this.pills = this._register(new ChatPillsWidget(element, {
			getId: (action: IArtifactButton) => action.id,
			create: (action: IArtifactButton) => this.createPill(action),
		}));
	}

	update(actions: readonly IArtifactButton[]): void {
		this.pills.update(actions);
		this.element.hidden = this.pills.size === 0;
	}

	private createPill(action: IArtifactButton): IChatPill<IArtifactButton> {
		const lifetime = new DisposableStore();
		const document = this.element.ownerDocument;
		const element = h(document, 'div', { className: 'ash-session-artifact-button' });
		const button = lifetime.add(createChatPillButton(element, { label: action.label, presentation: 'secondary', size: 'standard' }));
		const description = h(document, 'p');
		description.id = createUuid();
		element.append(description);
		lifetime.add(button.onDidClick(() => {
			if (button.enabled) action.run(button.domNode);
		}));
		lifetime.add(toDisposable(() => element.remove()));
		return Object.assign(lifetime, {
			element,
			update: (next: IArtifactButton) => {
				if (action.label !== next.label) button.label = next.label;
				action = next;
				button.enabled = next.enabled !== false;
				setAriaAttribute(button.domNode, 'pressed', next.pressed);
				description.textContent = next.description ?? '';
				description.hidden = next.description === undefined;
				setAriaAttribute(button.domNode, 'describedby', next.description === undefined ? undefined : description.id);
			},
		});
	}
}
