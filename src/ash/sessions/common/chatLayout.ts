import { Disposable } from '../../base/common/lifecycle.js';
import { autorun, derived, observableSignalFromEvent, type IObservable } from '../../base/common/observable.js';
import { extUri } from '../../base/common/resources.js';
import type { URI } from '../../base/common/uri.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';

export const SESSIONS_LAYOUT_SCOPE_SETTING = 'sessions.experimental.layoutScope';
export type ChatLayoutMode = 'session-shared' | 'chat-shared' | 'chat';

export interface IChatLayoutOwner {
	readonly sessionResource: URI;
	readonly chatResource: URI;
}

export function chatLayoutOwnersEqual(a: IChatLayoutOwner | undefined, b: IChatLayoutOwner | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return extUri.isEqual(a.sessionResource, b.sessionResource) && extUri.isEqual(a.chatResource, b.chatResource);
}

export interface IChatLayoutPresentationSnapshot {
	readonly mode: ChatLayoutMode;
	readonly active: boolean;
	readonly generation: number;
}

/** Derives layout policy from configuration and host presentation, without owning selection. */
export class ChatLayoutPresentation extends Disposable {
	public readonly state: IObservable<IChatLayoutPresentationSnapshot>;
	public get configured(): ChatLayoutMode {
		return this.state.get().mode;
	}

	constructor(startupDesktop: boolean, isPhoneLayout: IObservable<boolean>, @IConfigurationService configuration: IConfigurationService) {
		super();
		const changed = observableSignalFromEvent(this, listener =>
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(SESSIONS_LAYOUT_SCOPE_SETTING)) {
					listener(event);
				}
			}),
		);
		let generation = 0;
		this.state = derived(reader => {
			changed.read(reader);
			const mode = configuration.getValue<ChatLayoutMode>(SESSIONS_LAYOUT_SCOPE_SETTING) ?? 'session-shared';
			const active = startupDesktop && !isPhoneLayout.read(reader) && mode !== 'session-shared';
			return Object.freeze({ mode, active, generation: ++generation });
		});
		// Ash derived values only cache while observed; snapshots must retain one identity
		// throughout this owner's lifetime, including between queued operations.
		this._register(
			autorun(reader => {
				this.state.read(reader);
			}),
		);
	}

	public isCurrent(snapshot: IChatLayoutPresentationSnapshot): boolean {
		return !this.isDisposed && snapshot.active && snapshot === this.state.get();
	}
}

export interface IChatLayoutSnapshot {
	readonly owner: IChatLayoutOwner | undefined;
	readonly presentation: IChatLayoutPresentationSnapshot;
	readonly generation: number;
}

/** A queue operation retains this derived snapshot instead of retaining mutable Session objects. */
export class ChatLayoutContext extends Disposable {
	public readonly state: IObservable<IChatLayoutSnapshot>;
	constructor(
		private readonly presentation: ChatLayoutPresentation,
		owner: IObservable<IChatLayoutOwner | undefined>,
	) {
		super();
		let generation = 0;
		this.state = derived(reader =>
			Object.freeze({
				owner: owner.read(reader),
				presentation: presentation.state.read(reader),
				generation: ++generation,
			}),
		);
		this._register(
			autorun(reader => {
				this.state.read(reader);
			}),
		);
	}

	public isCurrent(snapshot: IChatLayoutSnapshot): boolean {
		const current = this.state.get();
		return !this.isDisposed && this.presentation.isCurrent(current.presentation) && snapshot.generation === current.generation && chatLayoutOwnersEqual(snapshot.owner, current.owner);
	}
}
