import { test as base } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./playwrightBrowser.js";
import { launchElectron } from "./playwrightElectron.js";
import type { PlaywrightApplication, PlaywrightDriver } from "./playwrightDriver.js";
import { playwrightTargetForProject, type PlaywrightTarget } from "./testTarget.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "./testWorkspace.js";
import { prepareDirectoryPermissions } from './prepareDirectoryPermissions.js';
import type { Workbench } from "./workbench.js";

interface PlaywrightFixtures {
	readonly includeLargeTestFile: boolean;
	readonly target: PlaywrightTarget;
	readonly application: PlaywrightApplication;
	readonly driver: PlaywrightDriver;
	readonly testWorkspace: TestWorkspace;
	readonly workbench: Workbench;
}

const FORBIDDEN_WORKBENCH_CONSOLE_ERRORS = ["App Server language document synchronization failed", "Declarative extension refresh failed"] as const;

export const test = base.extend<PlaywrightFixtures>({
	includeLargeTestFile: [false, { option: true }],
	target: async ({ baseURL }, use, testInfo) => {
		await use(playwrightTargetForProject(testInfo.project.name, baseURL));
	},
	testWorkspace: async ({ includeLargeTestFile }, use) => {
		const workspace = await createTestWorkspace({ includeLargeFile: includeLargeTestFile });
		try {
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
	driver: async ({ target, testWorkspace }, use) => {
		if (target.kind === "browser") {
			const { application, driver } = await launchBrowser(target);
			try {
				await use(driver);
			} finally {
				await application.close().catch(() => undefined);
			}
			return;
		}

		const userDataDirectory = await mkdtemp(join(tmpdir(), "ash-playwright-"));
		let launched: Awaited<ReturnType<typeof launchElectron>> | undefined;
		try {
			if (target.appServerMode === 'required') {
				await prepareDirectoryPermissions(join(userDataDirectory, 'profile'), testWorkspace.directory);
			}
			launched = await launchElectron({
				appServerMode: target.appServerMode,
				workbenchMode: target.workbenchMode,
				userDataDirectory,
				workspaceDirectory: testWorkspace.directory,
			});
			await use(launched.driver);
		} finally {
			await launched?.application.close().catch(() => undefined);
			await rm(userDataDirectory, { force: true, recursive: true });
		}
	},
	application: async ({ driver }, use) => {
		await use(driver.application);
	},
	workbench: async ({ driver }, use, testInfo) => {
		const workbench = driver.workbench;
		const page = workbench.page;
		const pageErrors: string[] = [];
		page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
		await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
		await use(workbench);

		const failed = testInfo.status !== testInfo.expectedStatus;
		if (failed && !page.isClosed()) {
			const screenshotPath = testInfo.outputPath("workbench.png");
			await page.screenshot({ path: screenshotPath });
			await testInfo.attach("workbench", { path: screenshotPath, contentType: "image/png" });
		}
		if (failed) {
			const tracePath = testInfo.outputPath("trace.zip");
			await page.context().tracing.stop({ path: tracePath });
			await testInfo.attach("trace", { path: tracePath, contentType: "application/zip" });
		} else {
			await page.context().tracing.stop();
		}
		if (pageErrors.length > 0 && !failed) {
			throw new Error(`Workbench page errors:\n${pageErrors.join("\n\n")}`);
		}
		const forbiddenConsoleErrors = driver.consoleErrors.filter(message => FORBIDDEN_WORKBENCH_CONSOLE_ERRORS.some(prefix => message.startsWith(prefix)));
		if (forbiddenConsoleErrors.length > 0 && !failed) {
			throw new Error(`Workbench emitted a forbidden console error:\n${forbiddenConsoleErrors.join("\n\n")}`);
		}
	},
});

export { expect } from "@playwright/test";
