import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatMessageReference } from '../../chat.js';

interface ReferenceButton extends DisposableStore {
	reference: ChatMessageReference;
	readonly button: Button;
}

/** Presents explicit message references and keeps their host-owned open actions current. */
export class ChatReferencesContentPart extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly buttons = this._register(new DisposableMap<string, ReferenceButton>());
	private references: readonly ChatMessageReference[] = [];

	constructor(private readonly body: HTMLElement, private readonly row: HTMLElement) {
		super();
		this.domNode = h(body.ownerDocument, 'div', { className: 'ash-chat-message-references' });
		this._register(toDisposable(() => this.domNode.remove()));
	}

	render(references: readonly ChatMessageReference[], beforeLayout?: () => void): boolean {
		const changed = references.length !== this.references.length || references.some((reference, index) => {
			const previous = this.references[index];
			return reference.id !== previous.id || reference.label !== previous.label;
		});
		this.references = references;
		if (!changed) {
			for (const reference of references) this.buttons.get(reference.id)!.reference = reference;
			return false;
		}
		beforeLayout?.();
		const document = this.domNode.ownerDocument;
		const active = document.activeElement as HTMLElement | null;
		const hadFocus = this.domNode.contains(active);
		const ids = new Set(references.map(reference => reference.id));
		for (const id of this.buttons.keys()) if (!ids.has(id)) this.buttons.deleteAndDispose(id);
		let next = this.domNode.firstChild;
		for (const reference of references) {
			const entry = this.buttons.get(reference.id) ?? this.buttons.set(reference.id, this.createButton(reference));
			entry.reference = reference;
			if (entry.button.label !== reference.label) entry.button.label = reference.label;
			const element = entry.button.domNode;
			if (element !== next) this.domNode.insertBefore(element, next);
			next = element.nextSibling;
		}
		if (!references.length) this.domNode.remove();
		else if (!this.domNode.parentElement) this.body.append(this.domNode);
		if (hadFocus && document.activeElement === document.body) (active?.isConnected ? active : this.row).focus({ preventScroll: true });
		return true;
	}

	private createButton(reference: ChatMessageReference): ReferenceButton {
		const lifetime = new DisposableStore();
		const button = lifetime.add(new Button(this.domNode, {
			...defaultButtonStyles, label: reference.label, icon: Lxicon.codeReview,
			presentation: 'quiet', size: 'small',
		}));
		button.domNode.dataset.chatReferenceId = reference.id;
		const entry = Object.assign(lifetime, { reference, button });
		lifetime.add(button.onDidClick(() => entry.reference.open(button.domNode)));
		lifetime.add(toDisposable(() => button.domNode.remove()));
		return entry;
	}
}
