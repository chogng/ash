import manifest from '../package.json' with { type: 'json' };
import { generalProfile, channelNotesProfile } from './generalProfile.js';
import { academyProfile } from './editorProfile.js';

/** Package-owned behavior becomes available only through a live Rust capability registration. */
export const packageId = `${manifest.publisher}.${manifest.name}`;
export const packageVersion = manifest.version;

export function getEditorProfile(editorId: string) {
	switch (editorId) {
		case 'stanza.editor.document': return academyProfile;
		case 'ash.editor.document': return generalProfile;
		case 'ash.collaboration.notes': return channelNotesProfile;
		default: throw new RangeError(`Unknown Academy editor '${editorId}'`);
	}
}
