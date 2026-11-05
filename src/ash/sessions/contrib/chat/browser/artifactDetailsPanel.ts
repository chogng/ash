import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { ArtifactAction, IArtifactIntegrationBinding } from '../../../../platform/artifactIntegrations/common/artifactIntegration.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/artifactIntegrations.css';

/** Displays provider-supplied action effects and returns only an explicitly chosen action. */
export class ArtifactDetailsPanel extends Disposable {
	readonly element: HTMLElement;
	private readonly title: HTMLHeadingElement;

	constructor(
		document: Document,
		binding: IArtifactIntegrationBinding,
		onChoose: (action: ArtifactAction) => void,
		onDismiss: () => void,
		renderFollowUp?: (container: HTMLElement) => Disposable,
	) {
		super();
		const element = this.element = h(document, 'section', { className: 'ash-session-artifact-details' });
		const title = this.title = h(document, 'h2');
		title.id = createUuid();
		title.textContent = localize('sessions.github.artifactActionPicker', 'Merge actions for {0}', binding.artifact.label);
		title.tabIndex = -1;
		element.setAttribute('role', 'dialog');
		element.setAttribute('aria-labelledby', title.id);
		const consent = h(document, 'p');
		if (binding.actions.length) {
			consent.textContent = localize('sessions.github.artifactActionConsent', 'Select an action to authorize its described effect');
		} else {
			consent.setAttribute('role', 'status');
			consent.textContent = localize('sessions.github.artifactNoActions', 'No merge actions are currently available for this pull request.');
		}
		element.append(title, consent);
		if (renderFollowUp) this._register(renderFollowUp(element));
		for (const action of binding.actions) {
			const button = this._register(new Button(element, { ...defaultButtonStyles, label: action.label, presentation: 'secondary' }));
			const effect = h(document, 'p');
			effect.id = createUuid();
			effect.textContent = action.description;
			element.append(effect);
			button.domNode.setAttribute('aria-describedby', effect.id);
			this._register(button.onDidClick(() => onChoose(action)));
		}
		const close = this._register(new Button(element, { ...defaultButtonStyles, label: localize('sessions.github.artifactCloseDetails', 'Close artifact details'), presentation: 'secondary' }));
		this._register(close.onDidClick(onDismiss));
		this._register(addDisposableListener(element, 'keydown', event => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				onDismiss();
			}
		}));
		this._register(toDisposable(() => element.remove()));
	}

	focus(): void {
		this.title.focus();
	}
}
