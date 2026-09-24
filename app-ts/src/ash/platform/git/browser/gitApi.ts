import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IGitApi } from "../common/gitApi.js";

export function createDisconnectedGitApi(unavailable: UnavailableOperation): IGitApi {
	return {
		readConfig: () => unavailable("git.readConfig"),
		updateConfig: () => unavailable("git.updateConfig"),
		repositories: () => unavailable("git.repositories"),
		status: () => unavailable("git.status"),
		history: () => unavailable("git.history"),
		branches: () => unavailable("git.branches"),
		switchBranch: () => unavailable("git.switchBranch"),
		graph: () => unavailable("git.graph"),
		commitChanges: () => unavailable("git.commitChanges"),
		commitFile: () => unavailable("git.commitFile"),
		changeFile: () => unavailable("git.changeFile"),
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
		readConfig: () => appServerRequest(connection, "config/read", {}),
		updateConfig: (params) => appServerRequest(connection, "config/update", params),
		repositories: () => appServerRequest(connection, "git/repositories", {}),
		status: (params) => appServerRequest(connection, "git/status", params),
		history: (params) => appServerRequest(connection, "git/history", params),
		branches: (params) => appServerRequest(connection, "git/branch/list", params),
		switchBranch: (params) => appServerRequest(connection, "git/branch/switch", params),
		graph: (params) => appServerRequest(connection, "git/graph", params),
		commitChanges: (params) => appServerRequest(connection, "git/commitChanges", params),
		commitFile: (params) => appServerRequest(connection, "git/commitFile", params),
		changeFile: (params) => appServerRequest(connection, "git/changeFile", params),
		stage: (params) => appServerRequest(connection, "git/stage", params),
		unstage: (params) => appServerRequest(connection, "git/unstage", params),
		discardWorktree: (params) => appServerRequest(connection, "git/discardWorktree", params),
		commit: (params) => appServerRequest(connection, "git/commit", params),
		fetch: (params) => appServerRequest(connection, "git/fetch", params),
		pull: (params) => appServerRequest(connection, "git/pull", params),
		push: (params) => appServerRequest(connection, "git/push", params),
	};
}
