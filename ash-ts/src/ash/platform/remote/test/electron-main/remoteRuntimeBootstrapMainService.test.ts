import { strict as assert } from "node:assert";
import { test } from "mocha";
import { URI } from "../../../../base/common/uri.js";
import type { RemoteRuntimeInstallProgress } from "../../../../platform/remote/common/remoteRuntimeInstallProgress.js";
import { createRemoteRuntimeInstallProgressLogger } from "../../../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { RemoteRuntimeBootstrapMainService } from "../../../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import type { IRemoteRuntimeConnectionProfiles } from "../../../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";

test("Remote runtime bootstrap binds install cancellation and settles its projection", async () => {
	let installSignal: AbortSignal | undefined;
	let reportProgress: ((progress: RemoteRuntimeInstallProgress) => void) | undefined;
	const service = new RemoteRuntimeBootstrapMainService({
		workspace: URI.parse("ash-remote://ssh+build-linux/workspace/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		localEnvironment: {},
		runtimeInstaller: {
			install: async (_host, options) => {
				installSignal = options?.signal;
				reportProgress = options?.onProgress;
				return "/opt/ash/bin/ash-remote-server";
			},
		},
	});
	try {
		const provisionRuntime = service.processLauncher.options.provisionRuntime;
		assert.ok(provisionRuntime);
		assert.equal(await provisionRuntime("build-linux"), "/opt/ash/bin/ash-remote-server");
		assert.ok(installSignal);
		assert.equal(installSignal.aborted, false);
		assert.deepEqual(service.installProgress.getState(), { host: "build-linux", status: "installing", phase: "probingPlatform" });
		reportProgress?.({ phase: "uploading", transferredBytes: 2, totalBytes: 4 });
		assert.deepEqual(service.installProgress.getState(), { host: "build-linux", status: "installing", phase: "uploading", transferredBytes: 2, totalBytes: 4 });

		service.installProgress.cancel();
		assert.equal(installSignal?.aborted, true);
		service.processLauncher.options.settleRuntimeProvision?.();
		assert.equal(service.installProgress.getState(), undefined);
	} finally {
		service.dispose();
	}
});

test("Remote runtime bootstrap delegates exact profile operations", async () => {
	const calls: string[] = [];
	const profiles: IRemoteRuntimeConnectionProfiles = {
		get: async (host, workspace) => {
			calls.push(`get:${host}:${workspace}`);
			return { activeRuntime: "/opt/ash/active/bin/ash-remote-server", previousRuntime: "/opt/ash/previous/bin/ash-remote-server" };
		},
		activate: async (host, workspace, runtime) => {
			calls.push(`activate:${host}:${workspace}:${runtime}`);
			return { activeRuntime: runtime };
		},
		rollback: async (host, workspace, sshExecutable) => {
			calls.push(`rollback:${host}:${workspace}:${sshExecutable}`);
			return { activeRuntime: "/opt/ash/previous/bin/ash-remote-server" };
		},
	};
	const service = new RemoteRuntimeBootstrapMainService({
		workspace: URI.parse("ash-remote://ssh+build-linux/workspace/project"),
		sshExecutable: "custom-ssh",
		remoteExecutable: "ash",
		localEnvironment: {},
		runtimeInstaller: { install: async () => "/opt/ash/new/bin/ash-remote-server" },
		connectionProfiles: profiles,
	});
	try {
		assert.equal(await service.processLauncher.options.resolveRuntime?.("build-linux", "/workspace/project"), "/opt/ash/active/bin/ash-remote-server");
		await service.processLauncher.options.activateRuntime?.("build-linux", "/workspace/project", "/opt/ash/new/bin/ash-remote-server");
		assert.equal(await service.processLauncher.options.rollbackRuntime?.("build-linux", "/workspace/project", "custom-ssh"), "/opt/ash/previous/bin/ash-remote-server");
		assert.deepEqual(calls, [
			"get:build-linux:/workspace/project",
			"activate:build-linux:/workspace/project:/opt/ash/new/bin/ash-remote-server",
			"rollback:build-linux:/workspace/project:custom-ssh",
		]);
	} finally {
		service.dispose();
	}
});

test("Remote runtime progress logger bounds download and upload chatter separately", () => {
	const messages: string[] = [];
	const structured: RemoteRuntimeInstallProgress[] = [];
	const log = createRemoteRuntimeInstallProgressLogger((message, progress) => {
		messages.push(message);
		if (progress) structured.push(progress);
	});
	log({ phase: "downloadingCatalog" });
	log({ phase: "downloadingArtifact", transferredBytes: 1, totalBytes: 100 });
	log({ phase: "downloadingArtifact", transferredBytes: 9, totalBytes: 100 });
	log({ phase: "downloadingArtifact", transferredBytes: 11, totalBytes: 100 });
	log({ phase: "validatingArtifact" });
	log({ phase: "uploading", transferredBytes: 1, totalBytes: 100 });
	log({ phase: "uploading", transferredBytes: 9, totalBytes: 100 });
	log({ phase: "uploading", transferredBytes: 11, totalBytes: 100 });
	log({ phase: "complete", disposition: "installed" });

	assert.deepEqual(messages, [
		"Remote runtime installation",
		"Remote runtime installation: downloaded 1%",
		"Remote runtime installation: downloaded 11%",
		"Remote runtime installation",
		"Remote runtime installation: uploaded 1%",
		"Remote runtime installation: uploaded 11%",
		"Remote runtime installation",
	]);
	assert.deepEqual(structured, [
		{ phase: "downloadingCatalog" },
		{ phase: "validatingArtifact" },
		{ phase: "complete", disposition: "installed" },
	]);
});
