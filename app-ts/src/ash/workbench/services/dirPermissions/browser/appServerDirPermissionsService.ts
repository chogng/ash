import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IServerEventApi } from '../../../../platform/app-server/common/appServerApi.js';
import type { IDirPermissionsApi } from "../../../../platform/dirPermissions/common/dirPermissionsApi.js";
import type { DirPermission, DirPermissionsCommandResult, DirPermissionsSnapshot, IDirPermissionsService } from "../../../../platform/dirPermissions/common/dirPermissionsService.js";

/** App Server transport adapter for directory permissions. */
export class AppServerDirPermissionsService extends Disposable implements IDirPermissionsService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangePermissions = this.changed.event;

	constructor(private readonly api: IDirPermissionsApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === 'config/changed') this.changed.fire();
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async list(): Promise<DirPermissionsSnapshot> {
		const result = await this.api.list();
		return {
			revision: result.revision,
			entries: result.entries.map(entry => ({
				dir: entry.dir,
				path: entry.path ?? undefined,
				permissions: entry.permissions,
			})),
		};
	}

	async read(path: string): Promise<readonly DirPermission[] | undefined> {
		return (await this.api.read({ path })).permissions ?? undefined;
	}

	async set(path: string, permissions: readonly DirPermission[], expectedRevision: number): Promise<DirPermissionsCommandResult> {
		return projectCommandResult(await this.api.set({
			commandId: commandId("set"),
			expectedRevision,
			path,
			permissions: [...permissions],
		}));
	}

	async forget(dir: string, expectedRevision: number): Promise<DirPermissionsCommandResult> {
		return projectCommandResult(await this.api.forget({
			commandId: commandId("forget"),
			expectedRevision,
			dir,
		}));
	}
}

function projectCommandResult(result: { revision: number; generation: number; disposition: "updated" | "replayed" }): DirPermissionsCommandResult {
	return { revision: result.revision, generation: result.generation, disposition: result.disposition };
}

function commandId(operation: string): string {
	return `desktop-dir-permissions-${operation}-${crypto.randomUUID()}`;
}
