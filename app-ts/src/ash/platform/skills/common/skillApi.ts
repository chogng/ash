export type SkillCatalogReload = "cached" | "refresh";

export interface SkillIdentity {
	readonly source: string;
	readonly name: string;
}

export interface SkillReference {
	readonly id: SkillIdentity;
	readonly version: { readonly type: "pinnedDigest"; readonly digest: string };
}

export interface SkillDescriptor {
	readonly id: SkillIdentity;
	readonly description: string;
	readonly contentDigest: string;
	readonly enabled: boolean;
	readonly compatible: boolean;
}

export interface SkillCatalog {
	readonly generation: number;
	readonly skills: readonly SkillDescriptor[];
}

/** Transport-neutral access to the App Server-owned metadata-only Skill catalog. */
export interface ISkillApi {
	list(reload: SkillCatalogReload): Promise<SkillCatalog>;
}

export function normalizeSkillCatalog(value: unknown): SkillCatalog {
	const catalog = record(value, "Skill catalog");
	if (!Number.isSafeInteger(catalog.generation) || (catalog.generation as number) < 0) throw new TypeError("Skill catalog generation is invalid");
	if (!Array.isArray(catalog.skills)) throw new TypeError("Skill catalog entries must be an array");
	return Object.freeze({
		generation: catalog.generation as number,
		skills: Object.freeze(catalog.skills.map(normalizeSkill)),
	});
}

function normalizeSkill(value: unknown): SkillDescriptor {
	const skill = record(value, "Skill");
	const id = record(skill.id, "Skill identity");
	const source = boundedText(id.source, "Skill source", 256);
	const name = boundedText(id.name, "Skill name", 64);
	const description = boundedText(skill.description, "Skill description", 1024);
	const contentDigest = boundedText(skill.contentDigest, "Skill digest", 96);
	const enablement = boundedText(skill.enablement, "Skill enablement", 16);
	const compatibility = record(skill.compatibility, "Skill compatibility");
	const compatibilityType = boundedText(compatibility.type, "Skill compatibility type", 16);
	if (enablement !== "enabled" && enablement !== "disabled") throw new TypeError("Skill enablement is invalid");
	if (compatibilityType !== "compatible" && compatibilityType !== "unknown") throw new TypeError("Skill compatibility is invalid");
	return Object.freeze({ id: Object.freeze({ source, name }), description, contentDigest, enabled: enablement === "enabled", compatible: compatibilityType === "compatible" });
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}
