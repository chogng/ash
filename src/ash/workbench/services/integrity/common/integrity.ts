import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IIntegrityService = createDecorator<IIntegrityService>('integrityService');

export interface ChecksumPair {
	readonly uri: URI;
	readonly actual: string | undefined;
	readonly expected: string;
	readonly isPure: boolean;
}

export interface IntegrityTestResult {
	/** Development runs have no published baseline and leave this value unset. */
	readonly isPure: boolean | undefined;
	readonly proof: readonly ChecksumPair[];
}

export interface IIntegrityService {
	readonly _serviceBrand: undefined;
	isPure(): Promise<IntegrityTestResult>;
}
