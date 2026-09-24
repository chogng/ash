import { type Event } from "../../../base/common/event.js";
import {
	Disposable,
} from "../../../base/common/lifecycle.js";
import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	RevisionedJsonFile,
} from "../../storage/node/revisionedJsonFile.js";
import {
	type IKeybindingEntry,
	type IKeybindingsResourceSnapshot,
	type IKeybindingsResourceUpdateRequest,
	KEYBINDINGS_RESOURCE_READ_CHANNEL,
	KEYBINDINGS_RESOURCE_UPDATE_CHANNEL,
	validateKeybindingsResource,
	validateKeybindingsResourceRead,
	validateKeybindingsResourceUpdateRequest,
} from "../common/keybindingsResource.js";

export interface KeybindingsResourceMainServiceOptions {
	readonly filePath: string;
	readonly onError?: (error: unknown) => void;
}

/**
 * Owns the active profile's `keybindings.json` in Electron main.
 */
export class KeybindingsResourceMainService extends Disposable {
	private readonly resource: RevisionedJsonFile<readonly IKeybindingEntry[]>;

	private constructor(
		resource: RevisionedJsonFile<readonly IKeybindingEntry[]>,
	) {
		super();
		this.resource = this._register(resource);
	}

	static async create(
		options: KeybindingsResourceMainServiceOptions,
	): Promise<KeybindingsResourceMainService> {
		const resource = await RevisionedJsonFile.create({
			filePath: options.filePath,
			defaultValue: () => [],
			validate: validateKeybindingsResource,
			label: "Keybindings resource",
			onError: options.onError,
		});
		return new KeybindingsResourceMainService(resource);
	}

	get onDidChange(): Event<IKeybindingsResourceSnapshot> {
		return (listener) => this.resource.onDidChange((snapshot) =>
			listener({
				revision: snapshot.revision,
				bindings: snapshot.value,
			})
		);
	}

	read(): IKeybindingsResourceSnapshot {
		const snapshot = this.resource.read();
		return {
			revision: snapshot.revision,
			bindings: snapshot.value,
		};
	}

	async update(
		request: IKeybindingsResourceUpdateRequest,
	): Promise<IKeybindingsResourceSnapshot> {
		const snapshot = await this.resource.update(
			request.expectedRevision,
			request.bindings,
		);
		return {
			revision: snapshot.revision,
			bindings: snapshot.value,
		};
	}

	async close(): Promise<void> {
		await this.resource.close();
		this.dispose();
	}
}

export function keybindingsResourceIpcRoutes(
	service: KeybindingsResourceMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: KEYBINDINGS_RESOURCE_READ_CHANNEL,
			validate: validateKeybindingsResourceRead,
			invoke: () => service.read(),
		},
		{
			channel: KEYBINDINGS_RESOURCE_UPDATE_CHANNEL,
			validate: validateKeybindingsResourceUpdateRequest,
			invoke: (request) =>
				service.update(request as IKeybindingsResourceUpdateRequest),
		},
	];
}
