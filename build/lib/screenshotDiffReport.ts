import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ScreenshotFixture {
	readonly fixtureId: string;
	readonly labels: readonly string[];
	readonly imageHash?: string;
	readonly imagePath?: string;
	readonly hasError?: boolean;
	readonly error?: string;
}

export interface ScreenshotManifest {
	readonly environment: { readonly platform: string; readonly browserVersion: string; };
	readonly fixtures: readonly ScreenshotFixture[];
}

/** Manifest files are an external boundary, including their references to image files. */
export async function readScreenshotManifest(path: string): Promise<ScreenshotManifest> {
	const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ScreenshotManifest> | null;
	if (!value?.environment || typeof value.environment.platform !== 'string' || typeof value.environment.browserVersion !== 'string' || !Array.isArray(value.fixtures)) {
		throw new Error(`Invalid screenshot manifest: ${path}`);
	}
	const seen = new Set<string>();
	for (const fixture of value.fixtures) {
		if (!fixture || typeof fixture.fixtureId !== 'string' || !fixture.fixtureId.trim() || /[\r\n]/.test(fixture.fixtureId) || seen.has(fixture.fixtureId)) throw new Error('Screenshot fixture IDs must be nonempty and unique');
		seen.add(fixture.fixtureId);
		if (!Array.isArray(fixture.labels) || fixture.labels.some((label: unknown) => typeof label !== 'string')) throw new Error(`Invalid screenshot labels: ${fixture.fixtureId}`);
		if (fixture.hasError !== undefined && typeof fixture.hasError !== 'boolean') throw new Error(`Invalid screenshot error state: ${fixture.fixtureId}`);
		if (fixture.error !== undefined && typeof fixture.error !== 'string') throw new Error(`Invalid screenshot error message: ${fixture.fixtureId}`);
		if (!fixture.imageHash && !fixture.imagePath) continue;
		if (typeof fixture.imageHash !== 'string' || !/^[a-f0-9]{64}$/.test(fixture.imageHash) || typeof fixture.imagePath !== 'string') throw new Error(`Invalid screenshot image reference: ${fixture.fixtureId}`);
		const image = resolve(dirname(path), fixture.imagePath);
		const inside = relative(dirname(path), image);
		if (isAbsolute(fixture.imagePath) || isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) throw new Error('Screenshot image must remain inside its manifest directory');
		const data = await readFile(image);
		if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || createHash('sha256').update(data).digest('hex') !== fixture.imageHash) throw new Error(`Screenshot PNG or hash is invalid: ${fixture.fixtureId}`);
	}
	return value as ScreenshotManifest;
}

export function compareScreenshotManifests(baseline: ScreenshotManifest, current: ScreenshotManifest) {
	if (baseline.environment.platform !== current.environment.platform || baseline.environment.browserVersion !== current.environment.browserVersion) throw new Error('Screenshot comparison requires the same platform and browser version');
	const before = new Map(baseline.fixtures.map(fixture => [fixture.fixtureId, fixture]));
	const after = new Map(current.fixtures.map(fixture => [fixture.fixtureId, fixture]));
	const entries = [...new Set([...before.keys(), ...after.keys()])].sort().map(fixtureId => {
		const baseline = before.get(fixtureId);
		const current = after.get(fixtureId);
		let status: 'unchanged' | 'changed' | 'added' | 'removed' | 'error';
		if ([baseline, current].some(fixture => fixture && (fixture.hasError || !fixture.imageHash || !fixture.imagePath))) status = 'error';
		else if (!baseline) status = 'added';
		else if (!current) status = 'removed';
		else status = baseline.imageHash === current.imageHash ? 'unchanged' : 'changed';
		return { fixtureId, status, baseline, current };
	});
	const count = (status: typeof entries[number]['status']): number => entries.filter(entry => entry.status === status).length;
	return { entries, summary: { unchanged: count('unchanged'), changed: count('changed'), added: count('added'), removed: count('removed'), error: count('error') } };
}

/** Report assets are self-contained, so CI artifacts need no external screenshot service. */
export async function writeScreenshotDiffReport(baselinePath: string, currentPath: string, out: string, commits?: { baseline: string; current: string; }, imageBaseURL?: string) {
	const [baseline, current] = await Promise.all([readScreenshotManifest(baselinePath), readScreenshotManifest(currentPath)]);
	const report = compareScreenshotManifests(baseline, current);
	await mkdir(resolve(out, 'images'), { recursive: true });
	const lines = ['# Screenshot comparison', '', `Unchanged: ${report.summary.unchanged}; changed: ${report.summary.changed}; added: ${report.summary.added}; removed: ${report.summary.removed}; errors: ${report.summary.error}.`, ''];
	if (commits) lines.push(`Baseline: \`${commits.baseline}\`; current: \`${commits.current}\` (working tree).`, '');
	for (const entry of report.entries.filter(entry => entry.status !== 'unchanged')) {
		lines.push(`## ${entry.fixtureId}: ${entry.status}`, '', '| Baseline | Current |', '| --- | --- |');
		const cells: string[] = [];
		for (const [fixture, path] of [[entry.baseline, baselinePath], [entry.current, currentPath]] as const) {
			if (fixture?.imageHash && fixture.imagePath) {
				const image = `images/${fixture.imageHash}.png`;
				await copyFile(resolve(dirname(path), fixture.imagePath), resolve(out, image));
				cells.push(`![screenshot](${imageBaseURL ? `${imageBaseURL.replace(/\/$/, '')}/images/${fixture.imageHash}` : image})`);
			} else cells.push(fixture?.error?.replaceAll('|', '\\|').replaceAll('\n', ' ') ?? '—');
		}
		lines.push(`| ${cells.join(' | ')} |`, '');
	}
	await writeFile(resolve(out, 'report.json'), `${JSON.stringify({ ...report, commits }, null, 2)}\n`);
	await writeFile(resolve(out, 'report.md'), `${lines.join('\n')}\n`);
	return report;
}

// Retain the upstream report entry's five positional arguments. Image hosting is
// optional: this implementation bundles assets instead of uploading them.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [serviceURL, baseSha, currentSha, baselinePath, currentPath, ...flags] = process.argv.slice(2);
	if (!baselinePath || !currentPath || flags.length && (flags.length !== 2 || flags[0] !== '--out')) throw new Error('Usage: node build/lib/screenshotDiffReport.ts <image-url|empty> <base-sha> <current-sha> <baseline-manifest> <current-manifest> [--out <dir>]');
	const out = resolve(flags[1] ?? resolve(dirname(currentPath), '../report'));
	const report = await writeScreenshotDiffReport(resolve(baselinePath), resolve(currentPath), out, { baseline: baseSha, current: currentSha }, serviceURL || undefined);
	process.stdout.write(await readFile(resolve(out, 'report.md'), 'utf8'));
	if (report.summary.error) process.exitCode = 1;
}
