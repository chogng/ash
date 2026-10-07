import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IGitApi } from "../common/gitApi.js";
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';

export function createDisconnectedGitApi(unavailable: UnavailableOperation): IGitApi {
	return {
		initialize: () => unavailable('git.initialize'),
		catalog: () => unavailable('git.catalog'),
		executeCommand: () => unavailable('git.executeCommand'),
		indexDiff: () => unavailable('git.indexDiff'),
		editIndex: () => unavailable('git.editIndex'),
		clone: () => unavailable("git.clone"),
		readConfig: () => unavailable("git.readConfig"),
		updateConfig: () => unavailable("git.updateConfig"),
		repositories: () => unavailable("git.repositories"),
		status: () => unavailable("git.status"),
		checkIgnore: () => unavailable('git.checkIgnore'),
		history: () => unavailable("git.history"),
		branches: () => unavailable("git.branches"),
		createBranch: () => unavailable('git.createBranch'),
		deleteBranch: () => unavailable('git.deleteBranch'),
		switchBranch: () => unavailable("git.switchBranch"),
		worktrees: () => unavailable('git.worktrees'),
		createWorktree: () => unavailable('git.createWorktree'),
		deleteWorktree: () => unavailable('git.deleteWorktree'),
		resolveWorktree: () => unavailable('git.resolveWorktree'),
		graph: () => unavailable("git.graph"),
		compareChanges: () => unavailable('git.compareChanges'),
		commitMessage: () => unavailable('git.commitMessage'),
		commitDetails: () => unavailable('git.commitDetails'),
		commitChanges: () => unavailable("git.commitChanges"),
		commitFile: () => unavailable("git.commitFile"),
		changeFile: () => unavailable("git.changeFile"),
		conflictFile: () => unavailable("git.conflictFile"),
		completeConflict: () => unavailable("git.completeConflict"),
		stage: () => unavailable("git.stage"),
		unstage: () => unavailable("git.unstage"),
		discardWorktree: () => unavailable("git.discardWorktree"),
		commit: () => unavailable("git.commit"),
		fetch: () => unavailable("git.fetch"),
		pull: () => unavailable("git.pull"),
		push: () => unavailable("git.push"),
	};
}

export function createAppServerGitApi(connection: AppServerProtocolClient): IGitApi {
	return {
		initialize: params => appServerRequest(connection, 'git/init', params),
		catalog: params => appServerRequest(connection, 'git/catalog', params),
		executeCommand: params => appServerRequest(connection, 'git/command', params),
		indexDiff: params => appServerRequest(connection, 'git/indexDiff', params),
		editIndex: params => appServerRequest(connection, 'git/indexEdit', params),
		clone: (params) => appServerRequest(connection, "git/clone", params),
		readConfig: () => appServerRequest(connection, "config/read", {}),
		updateConfig: (params) => appServerRequest(connection, "config/update", params),
		repositories: () => appServerRequest(connection, "git/repositories", {}),
		status: (params) => appServerRequest(connection, "git/status", params),
		checkIgnore: async (params, token = CancellationToken.None) => {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const operationId = `git-ignore-${crypto.randomUUID()}`;
			const result = appServerRequest(connection, 'git/checkIgnore', { ...params, operationId });
			let cancellation: Promise<unknown> | undefined;
			using listener = token.onCancellationRequested(() => {
				// Keep the original request registered until the server sends its terminal response.
				cancellation = appServerRequest(connection, 'git/checkIgnore/cancel', { operationId });
				void cancellation.catch(() => undefined);
			});
			try {
				return await result;
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') {
					throw new CancellationError();
				}
				throw error;
			} finally {
				await cancellation;
			}
		},
		history: (params) => appServerRequest(connection, "git/history", params),
		branches: (params) => appServerRequest(connection, "git/branch/list", params),
		createBranch: params => appServerRequest(connection, 'git/branch/create', params),
		deleteBranch: params => appServerRequest(connection, 'git/branch/delete', params),
		switchBranch: (params) => appServerRequest(connection, "git/branch/switch", params),
		worktrees: params => appServerRequest(connection, 'git/worktree/list', params),
		createWorktree: params => appServerRequest(connection, 'git/worktree/create', params),
		deleteWorktree: params => appServerRequest(connection, 'git/worktree/delete', params),
		resolveWorktree: params => appServerRequest(connection, 'git/worktree/resolve', params),
		graph: (params) => appServerRequest(connection, "git/graph", params),
		compareChanges: params => appServerRequest(connection, 'git/compareChanges', params),
		commitMessage: params => appServerRequest(connection, 'git/commitMessage', params),
		commitDetails: params => appServerRequest(connection, 'git/commitDetails', params),
		commitChanges: (params) => appServerRequest(connection, "git/commitChanges", params),
		commitFile: (params) => appServerRequest(connection, "git/commitFile", params),
		changeFile: (params) => appServerRequest(connection, "git/changeFile", params),
		conflictFile: (params) => appServerRequest(connection, "git/conflictFile", params),
		completeConflict: (params) => appServerRequest(connection, "git/completeConflict", params),
		stage: (params) => appServerRequest(connection, "git/stage", params),
		unstage: (params) => appServerRequest(connection, "git/unstage", params),
		discardWorktree: (params) => appServerRequest(connection, "git/discardWorktree", params),
		commit: (params) => appServerRequest(connection, "git/commit", params),
		fetch: (params) => appServerRequest(connection, "git/fetch", params),
		pull: (params) => appServerRequest(connection, "git/pull", params),
		push: (params) => appServerRequest(connection, "git/push", params),
	};
}
