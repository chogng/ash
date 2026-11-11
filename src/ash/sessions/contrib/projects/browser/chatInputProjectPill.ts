import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { ProjectAppearance } from '../../../../platform/projects/common/projectService.js';
import { resolveProjectAppearance } from './projectAppearance.js';
import './chatInputProjectPill.css';

/** Hosts the composer picker and gives its selected project a leading clear action. */
export class ChatInputProjectPill extends Disposable {
	readonly element: HTMLElement;
	private readonly remove: Button;
	private projectIcon: HTMLElement | undefined;

	constructor(footer: HTMLElement, clearLabel: string, clearProject: () => void) {
		super();
		this.element = h(footer.ownerDocument, 'div', {
			className: 'ash-chat-input-workspace-slot ash-chat-input-project-pill',
			properties: { hidden: true },
		});
		footer.prepend(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.remove = this._register(new Button(this.element, {
			label: '', ariaLabel: clearLabel, title: clearLabel, size: 'small',
			onClick: clearProject,
		}));
		this.remove.domNode.classList.add('ash-chat-input-project-pill-remove');
		this.remove.domNode.hidden = true;
		appendIcon(Lxicon.close, this.remove.domNode);
	}

	update(appearance: ProjectAppearance | undefined, enabled: boolean): void {
		this.element.classList.toggle('has-project', appearance !== undefined);
		this.remove.domNode.hidden = appearance === undefined;
		this.remove.enabled = enabled;
		if (!appearance) return;
		const { icon = Lxicon.projectsFilled, color } = resolveProjectAppearance(this.element.ownerDocument, appearance);
		if (this.projectIcon?.dataset.ashIconId !== icon.id) {
			this.projectIcon?.remove();
			this.projectIcon = appendIcon(icon, this.remove.domNode);
			this.projectIcon.classList.add('ash-chat-input-project-pill-icon');
			this.remove.domNode.prepend(this.projectIcon);
		}
		this.projectIcon.style.color = color ?? '';
	}
}
