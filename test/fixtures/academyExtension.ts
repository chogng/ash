import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startExtensionProcess } from './markdownExtension.js';

let prepared = false;

export function prepareAcademyExtension(): void {
	if (prepared) return;
	execFileSync('just', ['test', 'ash-academy', '--no-run', '--locked'], { cwd: process.cwd(), timeout: 600_000, stdio: 'pipe', windowsHide: true });
	prepared = true;
}

/** The fixture supplies transport only; declarations come from the real Rust SDK executable. */
export function startAcademyExtension(language = 'en') {
	return startExtensionProcess('ash-academy', 'ash.academic', ['dataChannel'], language, [], {}, [], async () => ({ result: 'done' }), prepareAcademyExtension, resolve('.build/cargo/ci-test'));
}
