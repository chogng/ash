export type AppServerTestMode = "disabled" | "required";

export type PlaywrightTarget =
	| {
		readonly kind: "browser";
		readonly appServerMode: AppServerTestMode;
	}
	| {
		readonly kind: "electron";
		readonly appServerMode: AppServerTestMode;
	};

export function playwrightTargetForProject(projectName: string): PlaywrightTarget {
	switch (projectName) {
		case "browser-ui":
			return { kind: "browser", appServerMode: "disabled" };
		case "browser-app-server":
			return { kind: "browser", appServerMode: "required" };
		case "electron-ui":
			return { kind: "electron", appServerMode: "disabled" };
		case "electron-app-server":
		case "electron-editor-app-server":
		case "electron-pdf-corpus-app-server":
			return { kind: "electron", appServerMode: "required" };
		default:
			throw new Error(`Unsupported Playwright project: ${projectName}`);
	}
}
