import { isRecord } from '../../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { SessionPullRequestMergeMethod } from './pullRequestCreation.js';

export type CreatePullRequestAction = 'create' | 'sendToChat';
export type CreatePullRequestMergeMode = 'manual' | 'auto';

export interface ICreatePullRequestPreferences {
	readonly draft?: boolean;
	readonly mergeMode?: CreatePullRequestMergeMode;
	readonly mergeMethod?: SessionPullRequestMergeMethod;
	readonly primaryAction?: CreatePullRequestAction;
}

/** Last form choices are profile UI state; they never override repository capabilities. */
export class CreatePullRequestPreferences {
	private static readonly key = 'sessions.createPullRequest.preferences';

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@ILogService private readonly log: ILogService,
	) {}

	public read(): ICreatePullRequestPreferences {
		const raw = this.storage.get(CreatePullRequestPreferences.key, StorageScope.PROFILE);
		if (!raw) {
			return {};
		}
		try {
			return this.validate(JSON.parse(raw));
		} catch {
			// Stored data may contain private text; report the operation without the input.
			this.log.warn('Changes', 'Could not read pull request form preferences.');
			return {};
		}
	}

	public update(change: ICreatePullRequestPreferences): void {
		const value = this.validate({ ...this.read(), ...change });
		try {
			this.storage.store(
				CreatePullRequestPreferences.key,
				JSON.stringify(value),
				StorageScope.PROFILE,
				StorageTarget.MACHINE,
			);
		} catch {
			this.log.warn('Changes', 'Could not save pull request form preferences.');
		}
	}

	private validate(value: unknown): ICreatePullRequestPreferences {
		if (!isRecord(value)) {
			return {};
		}
		return {
			...(typeof value.draft === 'boolean' ? { draft: value.draft } : {}),
			...(value.mergeMode === 'manual' || value.mergeMode === 'auto' ? { mergeMode: value.mergeMode } : {}),
			...(value.mergeMethod === 'MERGE' || value.mergeMethod === 'SQUASH' || value.mergeMethod === 'REBASE'
				? { mergeMethod: value.mergeMethod }
				: {}),
			...(value.primaryAction === 'create' || value.primaryAction === 'sendToChat'
				? { primaryAction: value.primaryAction }
				: {}),
		};
	}
}
