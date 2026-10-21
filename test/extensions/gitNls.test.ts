import assert from 'node:assert/strict';
import { test } from 'mocha';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../../extensions/git/package.json' with { type: 'json' };
import english from '../../extensions/git/package.nls.json' with { type: 'json' };
import chinese from '../../extensions/git/package.nls.zh-CN.json' with { type: 'json' };

test('Git SCM title contributions use compact product icons and the public history menu', () => {
	const menus = manifest.contributes.menus as Record<string, { command?: string; group?: string; }[]>;
	assert.ok(menus['scm/history/title'], 'History uses the public extension menu location');
	for (const menu of ['scm/title', 'scm/history/title']) {
		const primary = menus[menu].filter(item => item.group?.split('@')[0] === 'navigation');
		for (const item of primary) {
			const command = manifest.contributes.commands.find(command => command.command === item.command);
			assert.ok(command, item.command);
			const icon = (command as { icon?: string; }).icon;
			assert.match(icon ?? '', /^\$\([a-z-]+\)$/u, `${item.command} has a product icon`);
			assert.ok(existsSync(resolve('resources/icons', `${icon!.slice(2, -1)}.svg`)), `${item.command} icon exists`);
		}
	}
});

test('Git manifest localization resolves every contribution in English and Chinese', () => {
	const keys = [...JSON.stringify(manifest).matchAll(/%([\w.-]+)%/g)].map(match => match[1]);
	for (const key of keys) {
		assert.equal(typeof (english as Record<string, string>)[key], 'string', `English: ${key}`);
		assert.equal(typeof (chinese as Record<string, string>)[key], 'string', `Chinese: ${key}`);
	}
	for (const [key, value] of Object.entries(english)) {
		const translated = (chinese as Record<string, string>)[key];
		if (translated !== undefined) { assert.deepEqual([...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), [...translated.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), key); }
	}
});

test('Git is a Rust capability package and every enum has localized settings choices', () => {
	assert.equal(manifest.ashRuntime.kind, 'rust');
	assert.equal(manifest.ashRuntime.entrypoint, 'ash-git-extension');
	assert.equal('browser' in manifest, false);
	const sections = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
	for (const section of sections) {
		for (const [key, raw] of Object.entries(section.properties)) {
			const property = raw as { enum?: unknown[]; ashSetting?: { options?: { value: unknown; label: string; }[]; }; };
			if (!property.enum) continue;
			assert.deepEqual(property.ashSetting?.options?.map(option => option.value), property.enum, key);
			for (const option of property.ashSetting!.options!) {
				assert.match(option.label, /^%[^%]+%$/u, key);
				const message = option.label.slice(1, -1);
				assert.equal(typeof (english as Record<string, string>)[message], 'string', message);
				assert.equal(typeof (chinese as Record<string, string>)[message], 'string', message);
			}
		}
	}
});
