import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { ArtifactAction, IArtifactIntegrationBinding } from '../../../../platform/artifactIntegrations/common/artifactIntegration.js';
import type { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/artifactIntegrations.css';

/** Displays provider-supplied action effects and returns only an explicitly chosen action. */
export class ArtifactDetailsPanel extends Disposable {
	private readonly current = this._register(new MutableDisposable<DisposableStore>());

	constructor(private readonly anchor: HTMLElement, private readonly views: IContextViewService) {
		super();
	}

	choose(binding: IArtifactIntegrationBinding, renderFollowUp?: (container: HTMLElement) => Disposable): Promise<ArtifactAction | undefined> {
		if (this.isDisposed || !this.anchor.isConnected) return Promise.resolve(undefined);
		const resources = new DisposableStore();
		this.current.value = resources;
		const document = this.anchor.ownerDocument;
		const element = h(document, 'section', { className: 'ash-session-artifact-details' });
		const title = h(document, 'h2');
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
		if (renderFollowUp) resources.add(renderFollowUp(element));
		return new Promise(resolve => {
			resources.add(toDisposable(() => {
				resolve(undefined);
				if (element.isConnected) this.views.hide();
			}));
			for (const action of binding.actions) {
				const button = resources.add(new Button(element, { ...defaultButtonStyles, label: action.label, presentation: 'secondary' }));
				const effect = h(document, 'p');
				effect.id = createUuid();
				effect.textContent = action.description;
				element.append(effect);
				button.domNode.setAttribute('aria-describedby', effect.id);
				resources.add(button.onDidClick(() => {
					resolve(action);
					this.close();
				}));
			}
			const close = resources.add(new Button(element, { ...defaultButtonStyles, label: localize('sessions.github.artifactCloseDetails', 'Close artifact details'), presentation: 'secondary' }));
			resources.add(close.onDidClick(() => this.close()));
			resources.add(addDisposableListener(element, 'keydown', event => {
				if (event.key === 'Escape') {
					event.stopPropagation();
					this.close();
				}
			}));
			if (this.views.show({
				anchor: this.anchor,
				content: element,
				presentation: 'dialog',
				focusRestore: ContextViewFocusRestore.Previous,
				onHide: () => {
					if (this.current.value === resources) this.close();
				},
			})) {
				title.focus();
			} else {
				this.close();
			}
		});
	}

	close(): void {
		this.current.clear();
	}
}
