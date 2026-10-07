import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { ApplicationChecksums } from '../../../../platform/checksum/common/checksumService.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IIntegrityService, IntegrityTestResult } from '../common/integrity.js';

/** Converts the desktop host's fixed installation scan into the Workbench integrity contract. */
export class IntegrityService implements IIntegrityService {
	declare public readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.channel = mainProcessService.getChannel('checksum');
	}

	public async isPure(): Promise<IntegrityTestResult> {
		const value = await this.channel.call<unknown>('getApplicationChecksums');
		if (!value || typeof value !== 'object' || !('isBuilt' in value) || typeof value.isBuilt !== 'boolean' || !('proof' in value) || !Array.isArray(value.proof)) {
			throw new TypeError('Invalid application checksum result');
		}
		const proof = value.proof.map((entry: unknown) => {
			if (!entry || typeof entry !== 'object') {
				throw new TypeError('Invalid application checksum proof');
			}
			const fields = entry as Record<string, unknown>;
			const uri = fields.uri as Record<string, unknown> | undefined;
			const validUri = uri && typeof uri === 'object' && uri.scheme === Schemas.file && typeof uri.path === 'string';
			const validExpected = typeof fields.expected === 'string' && /^[a-f0-9]{64}$/u.test(fields.expected);
			const validActual = fields.actual === null || typeof fields.actual === 'string' && /^[a-f0-9]{64}$/u.test(fields.actual);
			if (!validUri || !validExpected || !validActual) {
				throw new TypeError('Invalid application checksum proof');
			}
			const pair = entry as ApplicationChecksums['proof'][number];
			return { uri: URI.revive(pair.uri), actual: pair.actual ?? undefined, expected: pair.expected, isPure: pair.actual === pair.expected };
		});
		if ((value.isBuilt && proof.length === 0) || (!value.isBuilt && proof.length !== 0)) {
			throw new TypeError('Application checksum result does not match its build mode');
		}
		return { isPure: value.isBuilt ? proof.every(pair => pair.isPure) : undefined, proof };
	}
}
