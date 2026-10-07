import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { getDefaultUserDataPath } from '../../node/userDataPath.js';

test('default user data paths use the operating-system application directory and product identity', () => {
	let root: string;
	if (process.platform === 'win32') {
		root = process.env.APPDATA!;
	} else if (process.platform === 'darwin') {
		root = join(homedir(), 'Library', 'Application Support');
	} else {
		root = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
	}
	assert.equal(getDefaultUserDataPath('Ash'), join(root, 'Ash'));
	assert.equal(getDefaultUserDataPath('Another Product'), join(root, 'Another Product'));
});
