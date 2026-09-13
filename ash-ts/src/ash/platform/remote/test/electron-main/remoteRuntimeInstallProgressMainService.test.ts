import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { RemoteRuntimeInstallProgressState } from "../../../../platform/remote/common/remoteRuntimeInstallProgress.js";
import { RemoteRuntimeInstallProgressMainService } from "../../../../platform/remote/electron-main/remoteRuntimeInstallProgressMainService.js";

test("Remote runtime installation progress is Main-owned and credential-free", () => {
	const service = new RemoteRuntimeInstallProgressMainService();
	const states: Array<RemoteRuntimeInstallProgressState | undefined> = [];
	const subscription = service.onDidChange(state => states.push(state));
	try {
		const operation = service.begin(" Build-Linux ");
		operation.report({ phase: "uploading", transferredBytes: 2048, totalBytes: 4096 });

		assert.deepEqual(states, [
			{ host: "build-linux", status: "installing", phase: "probingPlatform" },
			{ host: "build-linux", status: "installing", phase: "uploading", transferredBytes: 2048, totalBytes: 4096 },
		]);
		assert.throws(() => service.begin("another-host"), /already active/);

		operation.finish();
		assert.equal(service.getState(), undefined);
		assert.equal(states.at(-1), undefined);
	} finally {
		subscription.dispose();
		service.dispose();
	}
});

test("cancelling aborts only the active operation and fences stale reports", () => {
	const service = new RemoteRuntimeInstallProgressMainService();
	try {
		const first = service.begin("build-linux");
		service.cancel();
		assert.equal(first.signal.aborted, true);
		assert.equal(first.signal.reason, "Remote runtime installation cancelled by the user");
		assert.deepEqual(service.getState(), { host: "build-linux", status: "cancelling", phase: "probingPlatform" });

		first.report({ phase: "uploading", transferredBytes: 1, totalBytes: 2 });
		assert.deepEqual(service.getState(), { host: "build-linux", status: "cancelling", phase: "uploading", transferredBytes: 1, totalBytes: 2 });
		first.finish();

		const second = service.begin("prod-linux");
		first.report({ phase: "complete", disposition: "installed" });
		first.finish();
		assert.deepEqual(service.getState(), { host: "prod-linux", status: "installing", phase: "probingPlatform" });

		second.report({ phase: "complete", disposition: "reused" });
		service.cancel();
		assert.equal(second.signal.aborted, false);
		second.finish();
	} finally {
		service.dispose();
	}
});
