import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import type { ILocalGitService } from '../../../../platform/git/common/localGitService.js';

/** The host owns checkout creation and cleanup; return a folder only after Git succeeds. */
export async function cloneRepository(git: ILocalGitService, url: string, parent: URI, name: string, token: CancellationToken): Promise<URI> {
	if (token.isCancellationRequested) { throw new CancellationError(); }
	const operation = crypto.randomUUID();
	const target = URI.joinPath(parent, name);
	const listener = token.onCancellationRequested(() => { void git.cancel(operation).catch(() => undefined); });
	try {
		await git.clone(operation, url, target.fsPath);
		if (token.isCancellationRequested) { throw new CancellationError(); }
		return target;
	} finally {
		listener.dispose();
	}
}
