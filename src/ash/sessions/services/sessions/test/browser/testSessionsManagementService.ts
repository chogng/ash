import type { ISessionsProvider } from '../../common/sessionsProvider.js';
import { SessionsManagementService } from '../../browser/sessionsManagementService.js';
import { SessionsProvidersService } from '../../browser/sessionsProvidersService.js';

/** Keeps single-provider fixtures explicit while production consumes the live registry. */
export class TestSessionsManagementService extends SessionsManagementService {
	private readonly registry: SessionsProvidersService;
	constructor(provider: ISessionsProvider) {
		const registry = new SessionsProvidersService();
		const registration = registry.registerProvider(provider);
		super(provider, registry);
		this.registry = registry;
		this._register(registration);
	}
	override dispose(): void {
		super.dispose();
		this.registry.dispose();
	}
}
