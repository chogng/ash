import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import type { ISessionsProvider } from '../common/sessionsProvider.js';

export interface ISessionsProvidersChangeEvent {
	readonly added: readonly ISessionsProvider[];
	readonly removed: readonly ISessionsProvider[];
}

export interface ISessionsProvidersService {
	readonly onDidChangeProviders: Event<ISessionsProvidersChangeEvent>;
	registerProvider(provider: ISessionsProvider): IDisposable;
	getProviders(): ISessionsProvider[];
	getProvider(providerId: string): ISessionsProvider | undefined;
}

export const ISessionsProvidersService = createServiceIdentifier<ISessionsProvidersService>('sessionsProvidersService');

/** Registrations borrow providers. Their Session management owner retains disposal responsibility. */
export class SessionsProvidersService extends Disposable implements ISessionsProvidersService {
	private readonly providers = new Map<string, ISessionsProvider>();
	private readonly changed = this._register(new Emitter<ISessionsProvidersChangeEvent>());
	readonly onDidChangeProviders = this.changed.event;

	registerProvider(provider: ISessionsProvider): IDisposable {
		this.assertNotDisposed();
		if (this.providers.has(provider.id)) throw new Error(`Duplicate Sessions provider: ${provider.id}`);
		this.providers.set(provider.id, provider);
		this.changed.fire({ added: [provider], removed: [] });
		return toDisposable(() => {
			if (this.isDisposed || this.providers.get(provider.id) !== provider) return;
			this.providers.delete(provider.id);
			this.changed.fire({ added: [], removed: [provider] });
		});
	}

	getProviders(): ISessionsProvider[] {
		return [...this.providers.values()].sort((a, b) => a.order - b.order);
	}

	getProvider(providerId: string): ISessionsProvider | undefined {
		return this.providers.get(providerId);
	}

	override dispose(): void {
		super.dispose();
		this.providers.clear();
	}
}

registerSingleton(ISessionsProvidersService, SessionsProvidersService, InstantiationType.Delayed);
