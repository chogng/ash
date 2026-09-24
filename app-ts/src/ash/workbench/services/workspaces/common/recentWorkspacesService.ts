import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** A project that can be reopened from the editor welcome page. */
export interface IRecentWorkspace {
	readonly name: string;
	readonly path: string;
	readonly root: string;
}

/** Owns durable Recent projects and routes their open operation to the host. */
export interface IRecentWorkspacesService {
	readonly recentWorkspaces: readonly IRecentWorkspace[];
	readonly onDidChange: Event<readonly IRecentWorkspace[]>;

	openWorkspace(root: string): Promise<void>;
}

export const IRecentWorkspacesService = createServiceIdentifier<IRecentWorkspacesService>("recentWorkspacesService");
