import { dirname, extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../files/common/files.js';
import type { ILogService } from '../../log/common/log.js';
import { AbstractPolicyService, validatePolicyValues } from './policy.js';

/** Reads an administrator-controlled JSON file; malformed replacement files retain prior policy. */
export class FilePolicyService extends AbstractPolicyService {
	private pending: Promise<void> = Promise.resolve();
	constructor(private readonly file: URI, private readonly files: IFileService, log: ILogService) {
		super();
		this._register(files.watch(dirname(file), { recursive: false, excludes: [] }));
		this._register(files.onDidChangeFiles(event => {
			if (!event.resources || event.resources.some(resource => extUriBiasedIgnorePathCase.isEqualOrParent(file, resource))) {
				void this.refresh().catch(error => log.error(getErrorMessage(error)));
			}
		}));
	}
	protected refresh(): Promise<void> {
		const operation = this.pending.then(async () => {
			if (this.stopped) return;
			try {
				const file = await this.files.readFile(this.file);
				if (file.content.length > 4 * 1024 * 1024) throw new TypeError('Policy file is too large');
				this.accept(validatePolicyValues(JSON.parse(file.content), this.policyDefinitions));
			} catch (error) {
				if (toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound) this.accept({});
				else throw error;
			}
		});
		this.pending = operation.catch(() => { });
		return operation;
	}
}
