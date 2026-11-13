import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { chatCreationKinds, type ChatCreationKind } from '../../../common/chatCreation.js';
import { appendArtifactIcon, getArtifactTitle } from '../../artifact/browser/artifactKindPresentation.js';
import { OPEN_CHAT_CREATION_COMMAND_ID } from '../common/constants.js';
import './media/chatCreationWidget.css';

/** Chooses the next Chat request's creative direction; it does not create a document. */
export class ChatCreationWidget extends Disposable {
	readonly domNode: HTMLElement;
	private readonly buttons = new Map<ChatCreationKind, Button>();

	constructor(ownerDocument: Document, @ICommandService commands: ICommandService) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-chat-creation' });
		for (const kind of chatCreationKinds) {
			const button = this._register(new Button(this.domNode, {
				...defaultButtonStyles, label: getArtifactTitle(kind),
				onClick: () => { void commands.executeCommand(OPEN_CHAT_CREATION_COMMAND_ID, kind); },
			}));
			button.domNode.classList.add('ash-chat-creation-button');
			button.domNode.dataset.creationKind = kind;
			const illustration = h(ownerDocument, 'span', {
				className: 'ash-chat-creation-illustration ash-artifact-type',
				attributes: { 'aria-hidden': 'true', 'data-artifact-kind': kind },
			});
			appendArtifactIcon(kind, illustration);
			button.domNode.prepend(illustration);
			this.buttons.set(kind, button);
		}
	}

	focus(kind: ChatCreationKind = 'docs'): void { this.buttons.get(kind)!.focus(); }
}
