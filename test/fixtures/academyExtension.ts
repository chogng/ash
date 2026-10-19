import { prepareClientEditorExtension, startClientEditorExtension } from './clientEditorExtension.js';

export function prepareAcademyExtension(): void {
	prepareClientEditorExtension('ash-academy');
}

/** The fixture supplies transport only; declarations come from the real Rust SDK executable. */
export function startAcademyExtension(language = 'en') {
	return startClientEditorExtension('ash-academy', 'ash.academic', language);
}
