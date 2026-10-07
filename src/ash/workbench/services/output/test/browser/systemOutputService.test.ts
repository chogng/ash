import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../common/output.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import type { AppServerConnectionState, IAppServerApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { SystemOutputService } from "../../browser/systemOutputService.js";

test("SystemOutputService projects App Server lifecycle", async () => {
	const listeners = new Set<(state: AppServerConnectionState) => void>();
	const appServer: IAppServerApi = {
		getConnectionState: async () => "ready",
		getSlashCommands: async () => [],
		onConnectionState: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
	};
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using service = new SystemOutputService(output, appServer);
	await Promise.resolve();
	for (const listener of listeners) listener("crashed");

	assert.match(output.getChannel("app-server")?.getText() ?? "", /Initial App Server connection state: ready/);
	assert.match(output.getChannel("app-server")?.getText() ?? "", /connection is crashed/);
});
