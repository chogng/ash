import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { ArtifactAction, IArtifactIntegrationBinding } from './artifactIntegration.js';

/** Keeps preparation, explicit user selection and dispatch in one invocation. */
export class ArtifactExecutionService extends Disposable {
	private readonly pending = new Map<string, CancellationTokenSource>();

	public async invoke(
		bindingId: string,
		prepare: (token: CancellationToken) => Promise<IArtifactIntegrationBinding>,
		select: (binding: IArtifactIntegrationBinding, token: CancellationToken) => Promise<ArtifactAction | undefined>,
		token: CancellationToken = CancellationToken.None,
	): Promise<void> {
		if (this.isDisposed || token.isCancellationRequested) throw new CancellationError();
		if (this.pending.has(bindingId)) {
			return;
		}
		using source = new CancellationTokenSource(token);
		this.pending.set(bindingId, source);
		try {
			const binding = await raceCancellationError(prepare(source.token), source.token);
			if (source.token.isCancellationRequested) throw new CancellationError();
			const action = await raceCancellationError(select(binding, source.token), source.token);
			if (source.token.isCancellationRequested) throw new CancellationError();
			if (!action || !binding.actions.includes(action)) return;
			const execution = await raceCancellationError(action.prepare(source.token), source.token);
			if (source.token.isCancellationRequested) throw new CancellationError();
			await execution();
		} finally {
			this.pending.delete(bindingId);
		}
	}

	protected override disposeCore(): void {
		for (const source of this.pending.values()) source.cancel();
		super.disposeCore();
	}
}
