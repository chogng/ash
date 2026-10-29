import { getMonacoEnvironment, type TrustedTypesPolicy, type TrustedTypesPolicyOptions } from './browser.js';
import { onUnexpectedError } from '../common/errors.js';

interface TrustedTypesFactory {
	createPolicy(policyName: string, policyOptions?: TrustedTypesPolicyOptions): TrustedTypesPolicy;
}

interface TrustedTypesGlobals {
	readonly trustedTypes?: TrustedTypesFactory;
}

/** Creates one Trusted Types policy through the embedding host or browser realm. */
export function createTrustedTypesPolicy(policyName: string, policyOptions?: TrustedTypesPolicyOptions): TrustedTypesPolicy | undefined {
	if (typeof policyName !== 'string' || policyName.length === 0) {
		throw new TypeError('Trusted Types policy name must be a non-empty string');
	}
	try {
		const environment = getMonacoEnvironment();
		if (environment?.createTrustedTypesPolicy) return environment.createTrustedTypesPolicy(policyName, policyOptions);
		return (globalThis as TrustedTypesGlobals).trustedTypes?.createPolicy(policyName, policyOptions);
	} catch (error) {
		onUnexpectedError(error);
		return undefined;
	}
}
