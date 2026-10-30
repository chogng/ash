import { app } from 'electron/main';
import { onUnexpectedError, setUnexpectedErrorHandler } from './ash/base/common/errors.js';

let didBootstrap = false;

/**
 * Applies process-wide Electron settings that must exist before `ready`.
 */
export function bootstrapElectronMain(): void {
	if (didBootstrap) {
		throw new Error('Electron main bootstrap can only run once');
	}
	didBootstrap = true;

	Error.stackTraceLimit = 100;
	app.enableSandbox();
	registerProcessErrorHandlers();
}

function registerProcessErrorHandlers(): void {
	// A development launcher can exit while Electron still owns a window. Its closed
	// output pipes must not feed write errors back into the console error handler.
	for (const stream of [process.stdout, process.stderr]) {
		stream.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code !== 'EPIPE') onUnexpectedError(error);
		});
	}
	process.on('uncaughtException', error => onUnexpectedError(error));
	process.on('unhandledRejection', reason => onUnexpectedError(reason));
	setUnexpectedErrorHandler(error => console.error('Unexpected error in Electron main process', error));
}
