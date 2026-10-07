import { app } from "electron/main";
import { onUnexpectedError, setUnexpectedErrorHandler } from "./ash/base/common/errors.js";

let didBootstrap = false;

/**
 * Applies process-wide Electron settings that must exist before `ready`.
 */
export function bootstrapElectronMain(): void {
	if (didBootstrap) {
		throw new Error("Electron main bootstrap can only run once");
	}
	didBootstrap = true;

	Error.stackTraceLimit = 100;
	app.enableSandbox();
	registerProcessErrorHandlers();
}

function registerProcessErrorHandlers(): void {
	process.on("uncaughtException", error => onUnexpectedError(error));
	process.on("unhandledRejection", reason => onUnexpectedError(reason));
	setUnexpectedErrorHandler(error => console.error("Unexpected error in Electron main process", error));
}
