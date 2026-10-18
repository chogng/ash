import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { parseLogLevel, isLogLevel, type LogLevel } from '../../../../platform/log/common/log.js';
import { Schemas } from '../../../../base/common/network.js';
import type { IWorkbenchEnvironmentService } from '../common/environmentService.js';

export class ElectronWorkbenchEnvironmentService implements IWorkbenchEnvironmentService {
	readonly argvResource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/argv.json' });
	readonly logLevel?: string;
	readonly initialLogLevel?: LogLevel;
	readonly extensionLogLevel?: readonly (readonly [string, string])[];
	public readonly webviewExternalEndpoint = `${Schemas.vscodeWebview}://{{uuid}}`;
	constructor(value?: unknown) {
		if (value === undefined) return;
		if (!isRecord(value) ||
			(value.logLevel !== undefined && (typeof value.logLevel !== 'string' || parseLogLevel(value.logLevel) === undefined)) ||
			(value.initialLogLevel !== undefined && !isLogLevel(value.initialLogLevel)) ||
			!Array.isArray(value.extensionLogLevel) || value.extensionLogLevel.length > 512 ||
			value.extensionLogLevel.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
				typeof entry[0] !== 'string' || !/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(entry[0]) ||
				typeof entry[1] !== 'string' || parseLogLevel(entry[1]) === undefined)) {
			throw new TypeError('Invalid startup log configuration');
		}
		this.logLevel = value.logLevel as string | undefined;
		this.initialLogLevel = value.initialLogLevel as LogLevel | undefined;
		this.extensionLogLevel = value.extensionLogLevel;
	}
}
