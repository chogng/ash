import { observableValue, type IReader, type ITransaction } from '../../../../base/common/observable.js';
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from '../common/session.js';

/** One visible slot in the dedicated Sessions Workbench. */
export type SessionsViewSelection =
	| { readonly kind: 'session'; readonly active: IActiveSessionThread; readonly sideThread?: true; }
	| { readonly kind: 'untitled'; readonly session: IUntitledChatSession; };

export interface SessionsSelection {
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
}

export type SessionsViewReference =
	| { readonly kind: 'session'; readonly sessionId: SessionId; readonly threadId: ThreadId; readonly sideThread?: true; }
	| { readonly kind: 'untitled'; readonly untitledSessionId: string; };

export type SessionSlotPlacement = 'open' | 'add' | number | { readonly index: number; readonly replacedBy: SessionsViewReference; };

/** Owns the slot order and preferred foreground identity for one Sessions window. */
export class VisibleSessions {
	private references: SessionsViewReference[] = [];
	// Retain an unresolved preferred slot while the catalog is unavailable.
	private preferred: SessionsViewReference | undefined;
	private readonly selection = observableValue<SessionsSelection>(this, { visibleSelections: [], activeSelection: undefined });

	constructor(private readonly resolve: (reference: SessionsViewReference) => SessionsViewSelection | undefined) { }

	read(reader?: IReader): SessionsSelection {
		return this.selection.read(reader);
	}

	get hasSlots(): boolean { return this.references.length > 0; }

	find(predicate: (reference: SessionsViewReference) => boolean): SessionsViewReference | undefined {
		return this.references.find(predicate);
	}

	restore(references: SessionsViewReference[], active: number, catalogUnavailable: boolean): void {
		this.references = references;
		this.preferred = references[active];
		this.publish(catalogUnavailable);
	}

	snapshot(): { readonly references: readonly SessionsViewReference[]; readonly active: number; } {
		return { references: this.references, active: this.references.findIndex(reference => visibilityKey(reference) === visibilityKey(this.preferred)) };
	}

	refresh(update: (reference: SessionsViewReference) => SessionsViewReference, catalogUnavailable: boolean): void {
		this.references = this.references.map(update);
		if (this.preferred) {
			this.preferred = update(this.preferred);
		}
		this.publish(catalogUnavailable);
	}

	select(reference: SessionsViewReference, placement: SessionSlotPlacement, catalogUnavailable: boolean, tx?: ITransaction): { readonly reference: SessionsViewReference; readonly index: number; } | undefined {
		let replaced: { readonly reference: SessionsViewReference; readonly index: number; } | undefined;
		const existing = this.references.findIndex(candidate => visibilityKey(candidate) === visibilityKey(reference));
		if (existing >= 0) {
			this.references[existing] = reference;
		} else if (placement === 'add') {
			this.references.push(reference);
		} else if (typeof placement === 'number') {
			this.references.splice(placement, 0, reference);
		} else if (typeof placement === 'object') {
			const index = this.references.findIndex(candidate =>
				visibilityKey(candidate) === visibilityKey(placement.replacedBy) && referenceKey(candidate) === referenceKey(placement.replacedBy));
			this.references.splice(index < 0 ? placement.index : index, index < 0 ? 0 : 1, reference);
		} else {
			// Ordinary opens replace the active editor group in place and preserve its siblings.
			const active = this.references.findIndex(candidate => visibilityKey(candidate) === visibilityKey(this.preferred));
			if (active >= 0) {
				replaced = { reference: this.references[active]!, index: active };
				this.references[active] = reference;
			} else {
				this.references = [reference];
			}
		}
		this.preferred = reference;
		this.publish(catalogUnavailable, tx);
		return replaced;
	}

	remove(selection: SessionsViewSelection, active: SessionsViewSelection | undefined): { readonly index: number; readonly wasActive: boolean; readonly replacement: SessionsViewReference | undefined; } | undefined {
		const key = sessionViewSelectionKey(selection);
		const index = this.references.findIndex(reference => visibilityKey(reference) === key);
		if (index < 0) {
			return undefined;
		}
		const wasActive = active !== undefined && sessionViewSelectionKey(active) === key;
		this.references.splice(index, 1);
		if (wasActive) {
			this.preferred = undefined;
		}
		const isVisible = (reference: SessionsViewReference) => this.resolve(reference) !== undefined;
		const replacement = this.references.slice(index).find(isVisible)
			?? this.references.slice(0, index).reverse().find(isVisible);
		return { index, wasActive, replacement };
	}

	publish(catalogUnavailable: boolean, tx?: ITransaction): void {
		const visibleSelections: SessionsViewSelection[] = [];
		let activeSelection: SessionsViewSelection | undefined;
		this.references = this.references.filter(reference => {
			const selection = this.resolve(reference);
			if (selection) {
				visibleSelections.push(selection);
				if (referenceKey(reference) === referenceKey(this.preferred) && visibilityKey(reference) === visibilityKey(this.preferred)) {
					activeSelection = selection;
				}
				return true;
			}
			return catalogUnavailable && reference.kind === 'session';
		});
		if (!activeSelection && !catalogUnavailable) {
			this.preferred = this.references[0];
		}
		this.selection.set({ visibleSelections, activeSelection: activeSelection ?? visibleSelections[0] }, tx);
	}
}

export function referenceForSelection(selection: SessionsViewSelection): SessionsViewReference {
	return selection.kind === 'session'
		? { kind: 'session', sessionId: selection.active.session.sessionId, threadId: selection.active.threadId, ...(selection.sideThread ? { sideThread: true } : {}) }
		: { kind: 'untitled', untitledSessionId: selection.session.untitledSessionId };
}

export function referenceKey(reference: SessionsViewReference | undefined): string | undefined {
	return reference?.kind === 'session'
		? `session:${JSON.stringify([reference.sessionId, reference.threadId])}`
		: reference ? `untitled:${reference.untitledSessionId}` : undefined;
}

export function sessionViewSelectionKey(selection: SessionsViewSelection): string {
	return visibilityKey(referenceForSelection(selection))!;
}

export function visibilityKey(reference: SessionsViewReference | undefined): string | undefined {
	return reference?.kind === 'session'
		? reference.sideThread ? `sideThread:${JSON.stringify([reference.sessionId, reference.threadId])}` : `session:${reference.sessionId}`
		: reference ? `untitled:${reference.untitledSessionId}` : undefined;
}
