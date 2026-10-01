import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'extensions/theme-defaults');
const manifestJson = await readFile(resolve(directory, 'package.json'), 'utf8');
const manifest = JSON.parse(manifestJson);
const resources: Record<string, string> = {};
for (const file of (await readdir(resolve(directory, 'themes'))).sort()) {
	if (file.endsWith('.json')) resources['themes/' + file] = await readFile(resolve(directory, 'themes', file), 'utf8');
}
const digest = (content: string): string => 'sha256:' + createHash('sha256').update(content).digest('hex');
const output = resolve(root, 'app-ts/src/ash/platform/extensions/common/generated/theme-defaults.json');
await mkdir(dirname(output), { recursive: true });
// Build and test entry points can prepare resources concurrently; publish a complete snapshot.
const temporary = output + '.' + randomUUID();
await writeFile(temporary, JSON.stringify({
	descriptor: {
		id: `${manifest.publisher}.${manifest.name}`, name: manifest.name, publisher: manifest.publisher,
		version: manifest.version, displayName: manifest.name, sourceKind: 'builtIn',
		manifestJson, manifestSha256: digest(manifestJson), packageSha256: digest(JSON.stringify(resources)),
	},
	resources,
}) + '\n');
await rename(temporary, output);
