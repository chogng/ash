import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableValue, type ISettableObservable } from '../../../../base/common/observable.js';
import { createUuid } from '../../../../base/common/uuid.js';
import './media/artifactDetailsCard.css';

/** Keeps a binding's card expansion across openings of its details panel. */
export class ArtifactDetailsCardState {
	private readonly cards = new Map<string, ISettableObservable<boolean>>();

	expansion(cardId: string): ISettableObservable<boolean> {
		let expanded = this.cards.get(cardId);
		if (!expanded) {
			expanded = observableValue('artifactDetailsCardExpanded', false);
			this.cards.set(cardId, expanded);
		}
		return expanded;
	}
}

/** Provides a named section with a keyboard-operable disclosure. */
export class ArtifactDetailsCard extends Disposable {
	readonly content: HTMLElement;

	constructor(container: HTMLElement, label: string, expanded: ISettableObservable<boolean>) {
		super();
		const document = container.ownerDocument;
		const section = h(document, 'section');
		const heading = h(document, 'h3', { className: 'ash-session-artifact-card-heading' });
		const disclosure = this._register(new Button(heading, { label, size: 'small' }));
		disclosure.domNode.id = createUuid();
		section.setAttribute('aria-labelledby', disclosure.domNode.id);
		this.content = h(document, 'div', { className: 'ash-session-artifact-card-content' });
		this.content.id = createUuid();
		disclosure.domNode.setAttribute('aria-controls', this.content.id);
		section.append(heading, this.content);
		container.append(section);
		this._register(toDisposable(() => section.remove()));
		this._register(disclosure.onDidClick(() => expanded.set(!expanded.get(), undefined)));
		this._register(autorun(reader => {
			const open = expanded.read(reader);
			if (!open && this.content.contains(document.activeElement)) {
				disclosure.domNode.focus({ preventScroll: true });
			}
			disclosure.icon = open ? Lxicon.chevronDown : Lxicon.chevronRight;
			disclosure.domNode.setAttribute('aria-expanded', String(open));
			this.content.hidden = !open;
		}));
	}
}
