import assert from 'node:assert/strict';
import { test } from 'mocha';
import manifest from '../../extensions/git/package.json' with { type: 'json' };
import english from '../../extensions/git/package.nls.json' with { type: 'json' };
import chinese from '../../extensions/git/package.nls.zh-CN.json' with { type: 'json' };
import { localize, setLanguage } from '../../extensions/git/browser/support.js';

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

test('Git extension localizes its own labels and parameterized accessibility text', () => {
	setLanguage('zh-CN');
	try {
		assert.equal(localize('git.ignored', 'Ignored by Git'), '被 Git 忽略');
		assert.equal(localize('git.autofetch.title', 'Auto Fetch'), '自动获取远端更新');
		assert.equal(localize('git.status.branch', 'Git branch {0}', 'feature'), 'Git 分支 feature');
	} finally { setLanguage('en'); }
});
