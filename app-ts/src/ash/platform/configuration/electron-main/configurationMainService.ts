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
	CONFIGURATION_READ_CHANNEL,
	CONFIGURATION_UPDATE_CHANNEL,
	emptyConfigurationDocument,
	type IConfigurationDocument,
	type IConfigurationSnapshot,
	type IConfigurationUpdateRequest,
	validateConfigurationDocument,
	validateConfigurationRead,
	validateConfigurationUpdateRequest,
} from "../common/configurationIpc.js";

export interface ConfigurationMainServiceOptions {
	readonly filePath: string;
	readonly onError?: (error: unknown) => void;
}

/**
 * Owns the Desktop configuration resource in the Electron main process.
 */
export class ConfigurationMainService extends Disposable {
	private readonly resource: RevisionedJsonFile<IConfigurationDocument>;

	private constructor(
		resource: RevisionedJsonFile<IConfigurationDocument>,
	) {
		super();
		this.resource = this._register(resource);
	}

	static async create(
		options: ConfigurationMainServiceOptions,
	): Promise<ConfigurationMainService> {
		const resource = await RevisionedJsonFile.create({
			filePath: options.filePath,
			defaultValue: emptyConfigurationDocument,
			validate: validateConfigurationDocument,
			label: "Configuration",
			onError: options.onError,
		});
		return new ConfigurationMainService(resource);
	}

	get onDidChange(): Event<IConfigurationSnapshot> {
		return (listener) => this.resource.onDidChange((snapshot) =>
			listener({
				revision: snapshot.revision,
				document: snapshot.value,
			})
		);
	}

	read(): IConfigurationSnapshot {
		const snapshot = this.resource.read();
		return {
			revision: snapshot.revision,
			document: snapshot.value,
		};
	}

	async update(
		request: IConfigurationUpdateRequest,
	): Promise<IConfigurationSnapshot> {
		const snapshot = await this.resource.update(
			request.expectedRevision,
			request.document,
		);
		return {
			revision: snapshot.revision,
			document: snapshot.value,
		};
	}

	async close(): Promise<void> {
		await this.resource.close();
		this.dispose();
	}
}

export function configurationIpcRoutes(
	service: Pick<ConfigurationMainService, "read" | "update">,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: CONFIGURATION_READ_CHANNEL,
			validate: validateConfigurationRead,
			invoke: () => service.read(),
		},
		{
			channel: CONFIGURATION_UPDATE_CHANNEL,
			validate: validateConfigurationUpdateRequest,
			invoke: (request) =>
				service.update(request as IConfigurationUpdateRequest),
		},
	];
}
