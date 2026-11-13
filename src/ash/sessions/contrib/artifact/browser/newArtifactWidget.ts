import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { chatCreationKinds } from '../../../common/chatCreation.js';
import { appendArtifactIcon, getArtifactTitle } from './artifactKindPresentation.js';
import { OPEN_CHAT_CREATION_COMMAND_ID } from '../../chat/common/constants.js';
import './newArtifactWidget.css';

/** Artifact creation shortcuts that start a chat with the selected artifact context. */
export class NewArtifactWidget extends Disposable {
	readonly domNode: HTMLElement;

	constructor(ownerDocument: Document, @ICommandService commands: ICommandService) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-new-artifact' });
		for (const kind of chatCreationKinds) {
			const button = this._register(new Button(this.domNode, {
				...defaultButtonStyles, label: getArtifactTitle(kind),
				onClick: () => { void commands.executeCommand(OPEN_CHAT_CREATION_COMMAND_ID, kind); },
			}));
			button.domNode.classList.add('ash-new-artifact-button');
			button.domNode.dataset.creationKind = kind;
			const illustration = h(ownerDocument, 'span', {
				className: 'ash-new-artifact-illustration ash-artifact-type',
				attributes: { 'aria-hidden': 'true', 'data-artifact-kind': kind },
			});
			appendArtifactIcon(kind, illustration);
			button.domNode.prepend(illustration);
		}
	}
}
