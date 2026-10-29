import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { getErrorMessage } from '../../../base/common/errors.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IStringDictionary } from '../../../base/common/collections.js';
import type { ILogService } from '../../log/common/log.js';
import { AbstractPolicyService, validatePolicyValues, type PolicyDefinition } from '../common/policy.js';

/** Desktop-only OS reader. Polling is shared by all windows and stops with the application. */
export class SystemPolicyService extends AbstractPolicyService {
	private pending: Promise<void> | undefined;
	private readonly cancellation = new AbortController();
	constructor(
		log: ILogService,
		private readonly read: (
			definitions: IStringDictionary<PolicyDefinition>,
			signal: AbortSignal,
		) => Promise<unknown> = readSystemPolicies,
		pollInterval = 2000,
	) {
		super();
		const timer = setInterval(() => {
			void this.refresh().catch(error => log.error(getErrorMessage(error)));
		}, pollInterval);
		timer.unref();
		this._register(
			toDisposable(() => {
				clearInterval(timer);
				this.cancellation.abort();
			}),
		);
	}
	protected refresh(): Promise<void> {
		if (this.pending) return this.pending;
		const operation = (async () => {
			while (!this.stopped && Object.keys(this.policyDefinitions).length) {
				const definitions = this.policyDefinitions;
				const values = await this.read(definitions, this.cancellation.signal);
				if (definitions !== this.policyDefinitions) continue;
				this.accept(validatePolicyValues(values, definitions));
				return;
			}
		})().finally(() => {
			this.pending = undefined;
		});
		this.pending = operation;
		return operation;
	}
}

async function run(executable: string, args: string[], signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			args,
			{ encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, signal },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

async function readSystemPolicies(
	definitions: IStringDictionary<PolicyDefinition>,
	signal: AbortSignal,
): Promise<unknown> {
	if (process.platform === 'win32') {
		const { readWindowsRegistryPolicies } = await import('./windowsRegistryPolicy.js');
		signal.throwIfAborted();
		return readWindowsRegistryPolicies(definitions);
	}
	if (process.platform === 'darwin') {
		const file = '/Library/Managed Preferences/com.ash.desktop.plist';
		try {
			await access(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
			throw error;
		}
		return JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], signal));
	}
	throw new Error('This platform uses the system JSON policy file');
}
