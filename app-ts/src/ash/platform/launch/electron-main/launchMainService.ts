import { stat } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { URI } from '../../../base/common/uri.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { WorkspaceOpenTargetKind, type IParsedLaunchArguments } from '../../environment/common/argv.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import type { IWindowFileOpen } from '../../window/common/window.js';
import { hasWorkspaceFileExtension } from '../../workspace/common/workspace.js';

export interface IStartArguments {
	readonly args: IParsedLaunchArguments;
	readonly cwd: string;
}

export interface ILaunchMainService {
	start(request: IStartArguments): Promise<void>;
}

export const ILaunchMainService = createServiceIdentifier<ILaunchMainService>('launchMainService');

/** Coordinates external requests; window selection and editor lifetime remain with their owners. */
export class LaunchMainService extends Disposable implements ILaunchMainService {
	private readonly waitMarkers = this._register(new DisposableMap<string, IDisposable>());

	constructor(@IWindowsMainService private readonly windows: IWindowsMainService) {
		super();
	}

	public async start({ args, cwd }: IStartArguments): Promise<void> {
		this.assertNotDisposed();
		if (args.waitMarkerFilePath) {
			this.waitMarkers.set(args.waitMarkerFilePath, toDisposable(() => {
				try {
					unlinkSync(args.waitMarkerFilePath!);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw error;
					}
				}
			}));
		}
		try {
			let workspace = args.workspace;
			const files: IWindowFileOpen[] = [];
			for (const argument of args.paths) {
				const location = args.goto ? /^(.*?):(\d+)(?::(\d+))?$/.exec(argument) : null;
				const path = resolve(cwd, location ? location[1]! : argument);
				let isDirectory = false;
				try {
					isDirectory = (await stat(path)).isDirectory();
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw error;
					}
				}
				if (isDirectory || hasWorkspaceFileExtension(path)) {
					if (workspace) {
						throw new Error('One launch request may open only one workspace');
					}
					workspace = { kind: isDirectory ? WorkspaceOpenTargetKind.Folder : WorkspaceOpenTargetKind.Workspace, path };
				} else {
					const line = location ? Number(location[2]) : undefined;
					const column = location?.[3] ? Number(location[3]) : undefined;
					if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1)) || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) {
						throw new Error('File positions must be positive integers');
					}
					files.push({ uri: URI.file(path).toString(), line, column });
				}
			}
			const opened = await this.windows.open({ workspace, cwd, files, forceNewWindow: args.newWindow, forceReuseWindow: args.reuseWindow, waitForFiles: args.wait });
			if (args.waitMarkerFilePath) {
				// The secondary process waits on the marker; launch completion must not block startup or later requests.
				const finished = files.length > 0 ? opened.whenFilesClosed : opened.whenClosed;
				void finished.then(() => this.waitMarkers.deleteAndDispose(args.waitMarkerFilePath!)).catch(error => console.error('Failed to complete the waiting launch request', error));
			}
		} catch (error) {
			if (args.waitMarkerFilePath) {
				this.waitMarkers.deleteAndDispose(args.waitMarkerFilePath);
			}
			throw error;
		}
	}
}
