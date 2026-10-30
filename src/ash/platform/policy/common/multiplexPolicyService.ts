import type { PolicyValue } from '../../../base/common/policy.js';
import { AbstractPolicyService, type IPolicyService, type PolicyValueSource } from './policy.js';

/** The first defined source wins. Desktop registers system policy before account policy. */
export class MultiplexPolicyService extends AbstractPolicyService {
	constructor(private readonly sources: readonly IPolicyService[]) {
		super();
		for (const source of sources) this._register(source.onDidChange(() => this.combine()));
	}
	protected async refresh(): Promise<void> {
		await Promise.all(this.sources.map(source => source.updatePolicyDefinitions(this.policyDefinitions)));
		this.combine();
	}
	private combine(): void {
		const values: Record<string, PolicyValue> = {};
		const sources: Record<string, PolicyValueSource> = {};
		for (const name of Object.keys(this.policyDefinitions)) {
			for (const source of this.sources) {
				const value = source.getPolicyValue(name);
				if (value !== undefined) {
					Object.defineProperty(values, name, { value, enumerable: true });
					Object.defineProperty(sources, name, { value: source.getPolicyValueSource(name), enumerable: true });
					break;
				}
			}
		}
		this.accept(values, sources);
	}
}
