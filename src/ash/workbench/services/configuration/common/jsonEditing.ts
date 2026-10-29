import type { JSONPath } from '../../../../base/common/json.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IJSONEditingService = createDecorator<IJSONEditingService>('jsonEditingService');
export const enum JSONEditingErrorCode {
	ERROR_INVALID_FILE,
}
export class JSONEditingError extends Error {
	constructor(
		message: string,
		readonly code: JSONEditingErrorCode,
	) {
		super(message);
	}
}
export interface IJSONValue {
	path: JSONPath;
	value: unknown;
}
export interface IJSONEditingService {
	write(resource: URI, values: IJSONValue[], save: boolean): Promise<void>;
}
