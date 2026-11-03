import type { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';

/** File formats currently consumed by Ash's shared catalogs. */
export enum PromptsType {
	skill = 'skill',
	agent = 'agent',
	instructions = 'instructions',
}

/** Identifies draft syntax only; catalog discovery and authorization remain with the backend. */
export function getPromptFileType(resource: URI | undefined): PromptsType | undefined {
	if (!resource) { return undefined; }
	if (/\/\.ash\/agents\/[^/]+\.md$/u.test(resource.path)) { return PromptsType.agent; }
	if (/\/\.ash\/instructions\/[^/]+\.md$/u.test(resource.path)
		|| resource.scheme === Schemas.vscodeUserData && /^\/user\/instructions\/[^/]+\.md$/u.test(resource.path)) {
		return PromptsType.instructions;
	}
	if (resource.path.endsWith('/SKILL.md')) { return PromptsType.skill; }
	return undefined;
}
