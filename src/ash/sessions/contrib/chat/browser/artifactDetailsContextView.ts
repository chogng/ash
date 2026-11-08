import { ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ArtifactAction, IArtifactIntegrationBinding } from '../../../../platform/artifactIntegrations/common/artifactIntegration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ArtifactDetailsCardState } from './artifactDetailsCard.js';
import { ArtifactDetailsPanel } from './artifactDetailsPanel.js';

/** Owns one artifact picker until the user selects an action or closes it. */
export class ArtifactDetailsContextView extends Disposable {
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private readonly cardStates = new Map<string, ArtifactDetailsCardState>();

	constructor(
		private readonly anchor: HTMLElement,
		@IContextViewService private readonly views: IContextViewService,
	) {
		super();
	}

	choose(binding: IArtifactIntegrationBinding, renderFollowUp?: (container: HTMLElement, state: ArtifactDetailsCardState) => Disposable): Promise<ArtifactAction | undefined> {
		if (this.isDisposed || !this.anchor.isConnected) return Promise.resolve(undefined);
		const lifetime = this.current.value = new DisposableStore();
		const choice = new DeferredPromise<ArtifactAction | undefined>();
		const panel = new ArtifactDetailsPanel(this.anchor.ownerDocument, binding, action => {
			void choice.complete(action);
			this.close();
		}, () => this.close(), renderFollowUp && (container => {
			let state = this.cardStates.get(binding.id);
			if (!state) {
				state = new ArtifactDetailsCardState();
				this.cardStates.set(binding.id, state);
			}
			return renderFollowUp(container, state);
		}));
		lifetime.add(toDisposable(() => {
			if (!choice.isSettled) void choice.complete(undefined);
			if (panel.element.isConnected) this.views.hide();
		}));
		lifetime.add(panel);
		if (this.views.show({
			anchor: this.anchor,
			content: panel.element,
			presentation: 'dialog',
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				if (this.current.value === lifetime) this.close();
			},
		})) {
			panel.focus();
		} else {
			this.close();
		}
		return choice.p;
	}

	close(): void {
		this.current.clear();
	}
}
