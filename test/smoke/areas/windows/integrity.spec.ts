import { _electron, expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { hostIntegrityExecutable } from '../../../../.build/desktop/hostLogs.js';

type ApplicationChecksums = import('../../../../src/ash/platform/checksum/common/checksumService.js').ApplicationChecksums;
interface IntegrityProbe {
	__ashIntegrityScan(): Promise<{ original: ApplicationChecksums; changed: ApplicationChecksums; cached: ApplicationChecksums; externalRejected: boolean; }>;
}

const desktop = resolve(import.meta.dirname, '../../../..');

test('Desktop Rust integrity scan detects changed and missing installation files', { tag: ['@electron-ui'] }, async ({ }, testInfo) => {
	const root = testInfo.outputPath('installation');
	const paths = ['dist/main/src/main.js', 'dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs', 'dist/renderer/ash/electron-browser/workbench/workbench.html'];
	const checksums: Record<string, string> = {};
	for (const path of paths) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), 'published');
		checksums[path] = createHash('sha256').update('published').digest('hex');
	}
	await writeFile(join(root, 'package.json'), JSON.stringify({ checksums }));
	const config = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: testInfo.outputPath('user-data') });
	const entry = testInfo.outputPath('integrity-main.mjs');
	await writeFile(entry, `
import { app } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(desktop, '.build/desktop/main/src/bootstrap.js')).href)};
import { startElectronApplication } from ${JSON.stringify(pathToFileURL(join(desktop, '.build/desktop/main/src/ash/code/electron-main/main.js')).href)};
import { ChecksumService, checksumChannel } from ${JSON.stringify(pathToFileURL(join(desktop, '.build/desktop/main/src/ash/platform/checksum/electron-main/checksumService.js')).href)};
import { mkdir, rm, symlink, writeFile, unlink } from 'node:fs/promises';
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
globalThis.__ashIntegrityScan = async () => {
    const root = ${JSON.stringify(root)};
    const paths = ${JSON.stringify(paths)};
    const service = new ChecksumService(${JSON.stringify(join(desktop, '.build/desktop/main', hostIntegrityExecutable))});
    try {
        const channel = checksumChannel(root, true, service);
        const original = await channel.call('window:1', 'getApplicationChecksums');
        await writeFile(root + '/' + paths[0], 'changed');
        await unlink(root + '/' + paths[1]);
        const changed = await checksumChannel(root, true, service).call('window:1', 'getApplicationChecksums');
        const cached = await channel.call('window:2', 'getApplicationChecksums');
        const outside = root + '-external';
        await mkdir(outside);
        await writeFile(outside + '/main.js', 'published');
        await rm(root + '/dist/main/src', { recursive: true });
        await symlink(outside, root + '/dist/main/src', 'junction');
        let externalRejected = false;
        try { await service.scan(root); } catch { externalRejected = true; }
        return { original, changed, cached, externalRejected };
    } finally { service.dispose(); }
};
startElectronApplication();
`);
	const application = await _electron.launch({ executablePath: config.executablePath, args: config.args.map(argument => argument === desktop ? entry : argument), cwd: config.cwd, env: config.env });
	try {
		await expect((await application.firstWindow()).locator('.ash-workbench')).toBeVisible();
		const result = await application.evaluate(() => (globalThis as typeof globalThis & IntegrityProbe).__ashIntegrityScan());
		expect(result.original.proof.every((pair: { actual: string | null; expected: string; }) => pair.actual === pair.expected)).toBe(true);
		expect(result.changed.proof.filter((pair: { actual: string | null; expected: string; }) => pair.actual === pair.expected)).toHaveLength(1);
		expect(result.changed.proof.filter((pair: { actual: string | null; }) => pair.actual === null)).toHaveLength(1);
		expect(result.cached).toEqual(result.original);
		expect(result.externalRejected).toBe(true);
	} finally { await application.close(); }
});
