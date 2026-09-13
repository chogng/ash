import { strict as assert } from "node:assert";
import { test } from "mocha";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL } from "../../../../platform/remote/common/remoteRuntimeInstallProgress.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL } from "../../../../platform/remote/common/remoteRuntimeInstallProgress.js";
import { RemoteRuntimeInstallProgressMainService } from "../../../../platform/remote/electron-main/remoteRuntimeInstallProgressMainService.js";
import { remoteRuntimeInstallProgressIpcRoutes } from "../../../../platform/remote/electron-main/remoteRuntimeInstallProgressIpc.js";

test("bootstrap IPC can only read or cancel the active Main-owned operation", async () => {
	const service = new RemoteRuntimeInstallProgressMainService();
	try {
		const operation = service.begin("Build-Linux");
		const routes = remoteRuntimeInstallProgressIpcRoutes(service);
		const read = route(routes, REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL);
		const cancel = route(routes, REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL);

		assert.deepEqual(await read.invoke(read.validate(undefined)), { host: "build-linux", status: "installing", phase: "probingPlatform" });
		assert.throws(() => read.validate({ host: "attacker" }), /does not accept parameters/);
		assert.throws(() => cancel.validate({ password: "secret" }), /does not accept parameters/);

		await cancel.invoke(cancel.validate(undefined));
		assert.equal(operation.signal.aborted, true);
		assert.deepEqual(await read.invoke(read.validate(undefined)), { host: "build-linux", status: "cancelling", phase: "probingPlatform" });
	} finally {
		service.dispose();
	}
});

function route(routes: readonly { readonly channel: string; readonly validate: (value: unknown) => unknown; readonly invoke: (value: unknown) => unknown }[], channel: string) {
	return routes.find(candidate => candidate.channel === channel)!;
}
