import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { ContextKeyExpression } from '../../contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../instantiation/common/instantiation.js';
import type { AccessibleContentProvider, AccessibleViewType } from './accessibleView.js';

export interface IAccessibleViewImplementation {
	readonly type: AccessibleViewType;
	readonly priority: number;
	readonly name: string;
	readonly when?: ContextKeyExpression;
	getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined;
}

class AccessibleViewImplementationRegistry {
	private readonly implementations: IAccessibleViewImplementation[] = [];

	public register(implementation: IAccessibleViewImplementation): IDisposable {
		if (this.implementations.some(candidate => candidate.name === implementation.name && candidate.type === implementation.type)) {
			throw new Error('Accessible view provider already registered: ' + implementation.name);
		}
		this.implementations.push(implementation);
		return toDisposable(() => {
			const index = this.implementations.indexOf(implementation);
			if (index >= 0) this.implementations.splice(index, 1);
		});
	}

	public getImplementations(): readonly IAccessibleViewImplementation[] {
		return this.implementations;
	}
}

export const AccessibleViewRegistry = new AccessibleViewImplementationRegistry();
