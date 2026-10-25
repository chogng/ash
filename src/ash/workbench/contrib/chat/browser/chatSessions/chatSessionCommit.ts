import { canceled } from '../../../../../base/common/errors.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';

/** The product retains the draft, durable identity, composer choices and subscriptions. */
export interface IChatSessionCommitDelegate<T> {
	resolve(): Promise<T>;
	isCurrent(): boolean;
	adopt(session: T): IDisposable;
	promote(session: T): void;
	subscribe(session: T): Promise<void>;
}

/** Publishes a provider's committed identity without lending a retired composer to it. */
export async function commitChatSession<T>(delegate: IChatSessionCommitDelegate<T>): Promise<T> {
	const session = await delegate.resolve();
	const current = delegate.isCurrent();
	// Catalog publication must survive navigation. Composer adoption must precede
	// publication: listeners may synchronously replace an incidental catalog pane.
	using adoption = current ? delegate.adopt(session) : undefined;
	delegate.promote(session);
	if (!current || !delegate.isCurrent()) throw canceled();
	await delegate.subscribe(session);
	if (!delegate.isCurrent()) throw canceled();
	return session;
}
