import { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import {
	DEVELOPMENT_DIR_PERMISSIONS,
	type IWorkspaceTrustInfo,
	type IWorkspaceTrustManagementService,
	type IWorkspaceTrustTransitionParticipant,
	type IWorkspaceTrustUriInfo,
} from '../../../platform/workspace/common/workspaceTrust.js';

/** Explicit, initially trusted window for tests unrelated to backend authorization. */
export class TestWorkspaceTrustManagementService extends Disposable implements IWorkspaceTrustManagementService {
	readonly onDidChangeTrust = Event.None as Event<boolean>;
	readonly onDidChangeTrustedFolders = Event.None;
	readonly workspaceResolved = Promise.resolve();
	readonly workspaceTrustInitialized = Promise.resolve();
	private trusted = true;
	private readonly participants = new Set<IWorkspaceTrustTransitionParticipant>();

	isWorkspaceTrusted(): boolean {
		return this.trusted;
	}
	canSetWorkspaceTrust(): boolean {
		return true;
	}
	async resolveWorkspaceTrust(): Promise<void> {}
	async getWorkspaceTrustInfo(): Promise<IWorkspaceTrustInfo | undefined> {
		return { isTrusted: this.isWorkspaceTrusted(), isReadOnly: false };
	}
	async getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo> {
		return { uri, trusted: this.isWorkspaceTrusted(), permissions: DEVELOPMENT_DIR_PERMISSIONS };
	}
	async setWorkspaceTrust(trusted: boolean): Promise<void> {
		this.trusted = trusted;
		for (const participant of this.participants) await participant.participate(trusted);
	}
	async setUrisTrust(_uris: URI[], trusted: boolean): Promise<void> {
		await this.setWorkspaceTrust(trusted);
	}
	addWorkspaceTrustTransitionParticipant(participant: IWorkspaceTrustTransitionParticipant): IDisposable {
		this.participants.add(participant);
		return toDisposable(() => this.participants.delete(participant));
	}
	protected override disposeCore(): void {
		this.participants.clear();
		super.disposeCore();
	}
}
