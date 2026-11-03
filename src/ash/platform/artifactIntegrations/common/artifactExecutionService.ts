import type { ArtifactAction, IArtifactIntegrationBinding } from './artifactIntegration.js';

/** Keeps preparation, explicit user selection and dispatch in one invocation. */
export class ArtifactExecutionService {
	private readonly pending = new Set<string>();

	public async invoke(
		bindingId: string,
		prepare: () => Promise<IArtifactIntegrationBinding>,
		select: (binding: IArtifactIntegrationBinding) => Promise<ArtifactAction | undefined>,
	): Promise<void> {
		if (this.pending.has(bindingId)) {
			return;
		}
		this.pending.add(bindingId);
		try {
			const binding = await prepare();
			const action = await select(binding);
			if (action && binding.actions.includes(action)) {
				await action.invoke();
			}
		} finally {
			this.pending.delete(bindingId);
		}
	}
}
