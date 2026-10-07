import type { SkillDescriptor, SkillReference } from "../../../../platform/agentHost/common/appServerApi.js";
import type { SkillSelectorDefinition } from "../../../services/chat/common/chatService.js";

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SKILL_TOKEN = /(^|\s)\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=\s|$)/g;

/** A text selector must resolve to one enabled, compatible, source-qualified revision. */
export function toSkillSelectors(skills: readonly SkillDescriptor[]): readonly SkillSelectorDefinition[] {
	const available = skills.filter(skill => skill.enabled && skill.compatible);
	const counts = new Map<string, number>();
	for (const skill of available) counts.set(skill.id.name, (counts.get(skill.id.name) ?? 0) + 1);
	return available.filter(skill => counts.get(skill.id.name) === 1).map<SkillSelectorDefinition>(skill => ({
		name: skill.id.name,
		description: skill.description,
		source: skill.id.source,
		skill: { id: { ...skill.id }, version: { type: "pinnedDigest", digest: skill.contentDigest } },
	}));
}

/** Owns the enabled Skill snapshot shared by `$` completion and Turn submission. */
export class SkillSelectorCatalog {
	private entriesByName: ReadonlyMap<string, SkillSelectorDefinition> = new Map();
	private entries: readonly SkillSelectorDefinition[] = Object.freeze([]);

	public setSkills(skills: readonly SkillSelectorDefinition[]): void {
		const entriesByName = new Map<string, SkillSelectorDefinition>();
		const entries = skills.map(skill => {
			if (!SKILL_NAME.test(skill.name)) {
				throw new TypeError(`Invalid Skill name: ${skill.name}`);
			}
			if (!skill.description.trim()) {
				throw new TypeError(`Skill $${skill.name} requires a description`);
			}
			if (entriesByName.has(skill.name)) {
				throw new RangeError(`Duplicate Skill selector name: $${skill.name}`);
			}
			const entry = Object.freeze({ ...skill });
			entriesByName.set(entry.name, entry);
			return entry;
		});
		this.entriesByName = entriesByName;
		this.entries = Object.freeze(entries);
	}

	public matching(prefix: string): readonly SkillSelectorDefinition[] {
		return this.entries.filter(skill => skill.name.startsWith(prefix));
	}

	public referencesIn(text: string): readonly SkillReference[] {
		const references: SkillReference[] = [];
		const selectedNames = new Set<string>();
		for (const match of text.matchAll(SKILL_TOKEN)) {
			const name = match[2]!;
			if (selectedNames.has(name)) {
				continue;
			}
			const entry = this.entriesByName.get(name);
			if (!entry) {
				continue;
			}
			selectedNames.add(name);
			references.push(entry.skill);
		}
		return Object.freeze(references);
	}
}
