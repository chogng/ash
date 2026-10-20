import { resolve } from 'node:path';
import { prepareClientEditorExtension, startClientEditorExtension } from './clientEditorExtension.js';

export function prepareAcademyExtension(): void {
	if (!process.env.ASH_ACADEMY_DEVELOPMENT_PROJECT) prepareClientEditorExtension('ash-academy');
}

/** The fixture supplies transport only; declarations come from the real Rust SDK executable. */
export function startAcademyExtension(language = 'en') {
	return startClientEditorExtension('ash-academy', 'ash.academic', language, process.env.ASH_ACADEMY_DEVELOPMENT_PROJECT ? resolve(process.env.ASH_ACADEMY_DEVELOPMENT_PROJECT, 'target/debug') : undefined);
}
