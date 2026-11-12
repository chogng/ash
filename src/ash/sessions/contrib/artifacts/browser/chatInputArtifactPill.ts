import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ArtifactKind } from '../../../common/artifactKind.js';
import { appendArtifactIcon, getArtifactTitle } from './artifactKindPresentation.js';
import './chatInputArtifactPill.css';

export interface ArtifactDraftModel {
	readonly artifactDraftKind: ArtifactKind | undefined;
	setArtifactDraftKind(kind: ArtifactKind | undefined): boolean;
}

export function getArtifactDraftHelp(): string {
	return localize('sessions.artifacts.draftHelp', 'If a draft has an artifact type, Tab to its Remove button and press Enter or Space to clear the type and return to the message input. Your draft text and attachments stay in place.');
}

/** Renders the artifact type owned by the current draft. */
export class ChatInputArtifactPill extends Disposable {
	private readonly element: HTMLElement;
	private readonly text: HTMLElement;
	private readonly remove: Button;
	private kindIcon: Element | undefined;

	constructor(private readonly input: ChatInputPart, private readonly model: Pick<IChatWidgetModel, 'onDidChange'> & Partial<ArtifactDraftModel>) {
		super();
		const document = input.element.ownerDocument;
		this.element = h(document, 'span', {
			className: 'ash-chat-input-artifact-pill ash-artifact-type',
			properties: { hidden: true },
		});
		this.remove = this._register(new Button(this.element, {
			label: '', iconOnly: true, size: 'small',
			onClick: () => this.removeKind(),
		}));
		this.remove.domNode.classList.add('ash-chat-input-artifact-pill-remove');
		appendIcon(Lxicon.close, this.remove.domNode);
		this.text = h(document, 'span', { className: 'ash-chat-input-artifact-pill-label' });
		this.element.append(this.text);
		const footer = input.composerFooter;
		if (footer) footer.insertBefore(this.element, footer.querySelector('.ash-chat-input-toolbars'));
		else input.composerForm.after(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(model.onDidChange(() => this.render()));
		this.render();
	}

	private removeKind(): void {
		const kind = this.model.artifactDraftKind;
		if (!kind || !this.model.setArtifactDraftKind?.(undefined)) return;
		this.input.focus();
		status(localize('sessions.artifacts.draftRemoved', 'Removed {0} from this draft.', artifactDraftTitle(kind)));
	}

	private render(): void {
		const kind = this.model.artifactDraftKind;
		if (this.element.dataset.artifactKind === kind) return;
		this.element.hidden = kind === undefined;
		this.kindIcon?.remove();
		if (kind === undefined) {
			this.kindIcon = undefined;
			delete this.element.dataset.artifactKind;
			this.text.textContent = '';
			this.remove.setTitle(undefined);
			this.input.setDraftPlaceholder(undefined);
			return;
		}
		const title = artifactDraftTitle(kind);
		const removeLabel = localize('sessions.artifacts.removeDraftType', 'Remove {0}', title);
		this.element.dataset.artifactKind = kind;
		this.kindIcon = appendArtifactIcon(kind, this.remove.domNode);
		this.text.textContent = title;
		this.remove.domNode.setAttribute('aria-label', removeLabel);
		this.remove.setTitle(removeLabel);
		this.input.setDraftPlaceholder(getArtifactDraftPlaceholder(kind));
	}
}

function artifactDraftTitle(kind: ArtifactKind): string {
	return localize('sessions.artifacts.draftTitle', 'Ash {0}', getArtifactTitle(kind));
}

function getArtifactDraftPlaceholder(kind: ArtifactKind): string {
	switch (kind) {
		case 'docs': return localize('sessions.artifacts.promptDocs', 'What should this document be about?');
		case 'slides': return localize('sessions.artifacts.promptSlides', 'What should this deck be about?');
		case 'design': return localize('sessions.artifacts.promptDesign', 'What should this design show?');
		case 'sheet': return localize('sessions.artifacts.promptSheet', 'What should this sheet track?');
		case 'whiteboard': return localize('sessions.artifacts.promptWhiteboard', 'What should this whiteboard map out?');
		case 'data': return localize('sessions.artifacts.promptData', 'What do you want to learn from your data?');
		case 'motion': return localize('sessions.artifacts.promptMotion', 'What would you like to animate?');
	}
}
