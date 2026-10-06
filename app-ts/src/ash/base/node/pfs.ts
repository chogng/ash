import { promises as fs } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { isRecord } from '../common/types.js';

/** File operations whose platform behavior differs from a single filesystem request. */
export const Promises = {
	async rename(source: string, target: string, windowsRetryTimeout: number | false = 60_000): Promise<void> {
		const deadline = process.platform === 'win32' && windowsRetryTimeout !== false ? Date.now() + windowsRetryTimeout : 0;
		for (;;) {
			try {
				await fs.rename(source, target);
				return;
			} catch (error) {
				// Windows rejects replacing files held briefly by scanners or readers without delete sharing.
				if (!isRecord(error) || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code as string) || Date.now() >= deadline) {
					throw error;
				}
				await setTimeout(Math.min(50, deadline - Date.now()));
			}
		}
	},
};
