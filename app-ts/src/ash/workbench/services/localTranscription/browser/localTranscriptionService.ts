import { Event } from '../../../../base/common/event.js';
import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import type { ILocalTranscriptionService } from '../../../../platform/localTranscription/common/localTranscription.js';
import { localize } from '../../../../nls.js';

/** A browser host has no device-local Rust capture capability. */
export class NullLocalTranscriptionService extends AbstractDisposable implements ILocalTranscriptionService {
	public readonly _serviceBrand = undefined;
	public readonly isSupported = false;
	public readonly onDidTranscribe = Event.None;
	public readonly onDidEnd = Event.None;
	public async start(): Promise<never> {
		throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
	}
	public async stop(): Promise<string> { return ''; }
	public async cancel(): Promise<void> {}
	protected override disposeCore(): void {}
}
