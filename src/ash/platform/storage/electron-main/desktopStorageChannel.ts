import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CancellationToken, throwIfCancelled } from '../../../base/common/cancellation.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { DesktopStorageUsage } from '../common/profileStorageService.js';

/** Measures only Electron-owned data. The shared backend accounts for the profile and worktrees. */
export class DesktopStorageChannel implements IServerChannel {
	constructor(private readonly userDataRoot: string, private readonly profileRoot: string) { }

	async call<T>(_context: string, command: string, value: unknown, token = CancellationToken.None): Promise<T> {
		if (command !== 'measure' || typeof value !== 'string' || !isAbsolute(value) || value.length > 32_768 || value.includes('\0')) {
			throw new TypeError('Invalid desktop storage request');
		}
		return await this.measure(value, token) as T;
	}

	listen(): never { throw new Error('Desktop storage does not publish events'); }

	private async measure(worktreeRoot: string, token: CancellationToken): Promise<DesktopStorageUsage> {
		const [root, profile, worktrees] = await Promise.all([
			realpath(this.userDataRoot), realpath(this.profileRoot), realpath(worktreeRoot).catch(() => undefined),
		]);
		const covered = [profile];
		if (worktrees && !isWithin(worktrees, profile)) covered.push(worktrees);
		let bytes = 0;
		let complete = true;
		const pending = [root];
		while (pending.length) {
			throwIfCancelled(token);
			const path = pending.pop()!;
			if (covered.some(parent => isWithin(parent, path))) continue;
			try {
				const stat = await lstat(path);
				if (stat.isFile()) bytes += stat.size;
				else if (stat.isDirectory()) {
					for await (const entry of await opendir(path)) {
						throwIfCancelled(token);
						if (!entry.isSymbolicLink()) pending.push(join(path, entry.name));
					}
				}
			} catch (error) {
				throwIfCancelled(token);
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
			}
		}
		return { root, bytes, complete };
	}
}

function isWithin(parent: string, path: string): boolean {
	const fromParent = relative(parent, path);
	return fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}
