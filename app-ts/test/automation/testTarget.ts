export type AppServerTestMode = "disabled" | "required";
export type DesktopWorkbenchMode = "academic" | "code";

export type PlaywrightTarget =
	| {
			readonly kind: "browser";
			readonly appServerMode: AppServerTestMode;
			readonly baseURL: string;
			readonly workbenchMode: DesktopWorkbenchMode;
		}
	| {
			readonly kind: "electron";
			readonly appServerMode: AppServerTestMode;
			readonly workbenchMode: DesktopWorkbenchMode;
		};

export function playwrightTargetForProject(projectName: string, baseURL: string | undefined): PlaywrightTarget {
	switch (projectName) {
		case "browser-ui":
			return { kind: "browser", appServerMode: "disabled", baseURL: requiredBaseURL(baseURL, projectName), workbenchMode: testWorkbenchMode() };
		case "browser-app-server":
			return { kind: "browser", appServerMode: "required", baseURL: requiredBaseURL(baseURL, projectName), workbenchMode: testWorkbenchMode() };
		case "electron-ui":
			return { kind: "electron", appServerMode: "disabled", workbenchMode: testWorkbenchMode() };
		case "electron-academic-ui":
			return { kind: "electron", appServerMode: "disabled", workbenchMode: "academic" };
		case "electron-app-server":
		case "electron-editor-app-server":
		case "electron-pdf-corpus-app-server":
			return { kind: "electron", appServerMode: "required", workbenchMode: testWorkbenchMode() };
		default:
			throw new Error(`Unsupported Playwright project: ${projectName}`);
	}
}

function testWorkbenchMode(): DesktopWorkbenchMode {
	return process.env.ASH_WORKBENCH_MODE === "academic" ? "academic" : "code";
}

function requiredBaseURL(baseURL: string | undefined, projectName: string): string {
	if (baseURL === undefined) {
		throw new Error(`Playwright project '${projectName}' requires a baseURL`);
	}
	return baseURL;
}
