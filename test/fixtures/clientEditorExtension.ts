import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startExtensionProcess } from './markdownExtension.js';

const prepared = new Set<string>();

/** Product-client fixtures share transport and build ownership, never fake the capability implementation. */
export function prepareClientEditorExtension(packageName: string): void {
	if (prepared.has(packageName)) return;
	execFileSync('just', ['test', packageName, '--no-run', '--locked'], { cwd: process.cwd(), timeout: 600_000, stdio: 'pipe', windowsHide: true });
	prepared.add(packageName);
}

export function startClientEditorExtension(packageName: string, extensionId: string, language: string, binaryDirectory?: string) {
	return startExtensionProcess(packageName, extensionId, ['dataChannel'], language, [], {}, [], async () => ({ result: 'done' }),
		() => { if (!binaryDirectory) prepareClientEditorExtension(packageName); }, binaryDirectory ?? resolve('.build/cargo/ci-test'));
}
