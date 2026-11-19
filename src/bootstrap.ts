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
	if (process.platform === 'darwin') { configureMacGraphicsMemory(); }
	registerProcessErrorHandlers();
}

function configureMacGraphicsMemory(): void {
	if (!app.commandLine.hasSwitch('force-gpu-mem-discardable-limit-mb')) {
		app.commandLine.appendSwitch('force-gpu-mem-discardable-limit-mb', '32');
	}
	// On Apple Silicon, software raster reduces the footprint of Retina tiles
	// while leaving GPU compositing enabled. Keep Chromium's display-scaled
	// tile budget so resizing cannot exhaust a fixed app-wide limit.
	if (process.arch === 'arm64' && !app.commandLine.hasSwitch('enable-gpu-rasterization') && !app.commandLine.hasSwitch('disable-gpu-rasterization')) {
		app.commandLine.appendSwitch('disable-gpu-rasterization');
	}
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
