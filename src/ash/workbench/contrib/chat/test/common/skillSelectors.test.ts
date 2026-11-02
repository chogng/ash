import assert from 'node:assert/strict';
import { test } from 'mocha';
import { SkillSelectorCatalog } from '../../common/skillSelectors.js';

const commit = {
	name: 'commit',
	description: 'Draft a commit message',
	source: 'user:skill-source:test',
	skill: {
		id: { source: 'user:skill-source:test', name: 'commit' },
		version: { type: 'pinnedDigest' as const, digest: 'sha256:commit' },
	},
};

test('Skill selector matches `$` names and returns exact references in prompt order', () => {
	const catalog = new SkillSelectorCatalog();
	const review = {
		...commit,
		name: 'review',
		skill: { ...commit.skill, id: { ...commit.skill.id, name: 'review' } },
	};
	catalog.setSkills([commit, review]);

	assert.deepEqual(catalog.matching('com').map(skill => skill.name), ['commit']);
	assert.deepEqual(catalog.referencesIn('$review this, then $commit changes and reuse $review'), [review.skill, commit.skill]);
});

test('Skill selector ignores unknown names and embedded dollar text', () => {
	const catalog = new SkillSelectorCatalog();
	catalog.setSkills([commit]);

	assert.deepEqual(catalog.referencesIn('price$commit $missing $commitment'), []);
	assert.deepEqual(catalog.referencesIn('use $commit now'), [commit.skill]);
});

test('Skill selector rejects invalid and ambiguous entries', () => {
	const catalog = new SkillSelectorCatalog();
	assert.throws(() => catalog.setSkills([{ ...commit, name: 'Invalid' }]), /Invalid Skill name/);
	assert.throws(() => catalog.setSkills([commit, { ...commit }]), /Duplicate Skill selector name/);
});


test('Skill selector retains captured host digests across edits and catalog refreshes', () => {
	const catalog = new SkillSelectorCatalog();
	const newer = { ...commit, skill: { ...commit.skill, version: { type: 'pinnedDigest' as const, digest: 'new' } } };
	catalog.setSkills([newer]);
	assert.deepEqual(catalog.referencesIn('$commit more text', [commit.skill]), [commit.skill]);
	assert.deepEqual(catalog.referencesIn('removed token', [commit.skill]), []);
	catalog.setSkills([]);
	assert.deepEqual(catalog.referencesIn('$commit more text', [commit.skill]), [commit.skill]);
});
