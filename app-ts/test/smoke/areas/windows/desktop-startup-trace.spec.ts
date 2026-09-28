import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, homedir, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { launchElectron, type ElectronLaunchMilestone, type ElectronLaunchResult } from '../../../automation/playwrightElectron.js';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server/electron-main/appServerPackage.js';

const execFileAsync = promisify(execFile);
const samplesPerCohort = 5;
const accountHome = homedir();

interface ConnectionSample {
	readonly cohort: 'fresh' | 'stopped' | 'reused' | 'ui-only';
	readonly index: number;
	readonly readyMs: number | null;
	readonly milestones: readonly { phase: 'launch-requested' | ElectronLaunchMilestone; elapsedMs: number }[];
	readonly error?: string;
}

test('Desktop startup trace', async ({ target, testWorkspace }, testInfo) => {
	test.skip(process.env.ASH_DESKTOP_STARTUP_TRACE !== '1' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Run explicitly to measure Desktop startup.');
	test.setTimeout(240_000);
	const directory = await mkdtemp(join(tmpdir(), 'ash-trace-'));
	const priorHome = process.env.HOME;
	const priorUserProfile = process.env.USERPROFILE;
	process.env.HOME = directory;
	process.env.USERPROFILE = directory;
	const appPath = resolve(import.meta.dirname, '../../../..');
	const traceDirectory = resolve(appPath, '../.build/startup-trace', `desktop-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`);
	const packageLocation = { appPath, isPackaged: false, platform: process.platform, resourcesPath: '' };
	const daemon = appServerDaemonExecutablePath(packageLocation);
	const backend = appServerExecutablePath(packageLocation);
	const samples: ConnectionSample[] = [];
	let stoppedProfile: string | undefined;
	let reusedProfile: string | undefined;
	let setupDesktop: ElectronLaunchResult | undefined;
	let liveDesktop: ElectronLaunchResult | undefined;
	const metadata: Record<string, unknown> = {
		platform: process.platform,
		architecture: process.arch,
		osRelease: release(),
		cpuModel: cpus()[0]?.model ?? 'unknown',
		cpuCount: cpus().length,
		buildId: undefined,
		backendBytes: undefined,
		workbenchMode: 'code',
		workspace: 'isolated test workspace',
		credentialFixture: 'offline test credentials',
		readiness: 'document complete, visible Workbench and editor group, two animation frames',
		measurement: 'one Playwright worker clock, immediately before launchElectron through Workbench ready',
		cache: 'new user data for every sample; operating-system file cache is not cleared',
		profileState: 'fresh profiles include Playwright trust selection; stopped, reused, and UI-only use an authorized profile',
		milestoneClock: 'Playwright worker performance.now; each elapsed time is relative to launch-requested in the same process',
	};
	const stop = async (profile: string): Promise<void> => {
		await execFileAsync(daemon, ['stop'], { env: { ...process.env, ASH_HOME: profile }, windowsHide: true, timeout: 30_000 });
	};
	const measure = async (
		cohort: ConnectionSample['cohort'],
		index: number,
		profile: string | undefined,
		stopAfter: boolean,
	): Promise<void> => {
		let desktop: ElectronLaunchResult | undefined;
		const start = performance.now();
		let readyMs: number | null = null;
		let error: string | undefined;
		const milestones: { phase: 'launch-requested' | ElectronLaunchMilestone; elapsedMs: number }[] = [{ phase: 'launch-requested', elapsedMs: 0 }];
		try {
			desktop = await launchElectron({
				appServerMode: cohort === 'ui-only' ? 'disabled' : 'required',
				userDataDirectory: join(directory, `${cohort}-${index}`),
				profileDirectory: profile,
				workspaceDirectory: testWorkspace.directory,
				workspacePermissions: cohort === 'fresh' ? 'development' : undefined,
			}, phase => milestones.push({ phase, elapsedMs: Math.round(performance.now() - start) }));
			readyMs = Math.round(performance.now() - start);
		} catch (cause) {
			error = redact(String(cause), directory, testWorkspace.directory);
		} finally {
			try {
				await desktop?.close();
			} catch (cause) {
				error = `${error ? `${error}\n` : ''}Cleanup: ${redact(String(cause), directory, testWorkspace.directory)}`;
			}
			try {
				if (stopAfter && profile) await stop(profile);
			} catch (cause) {
				error = `${error ? `${error}\n` : ''}Cleanup: ${redact(String(cause), directory, testWorkspace.directory)}`;
			}
			samples.push({ cohort, index, readyMs, milestones, ...(error ? { error } : {}) });
		}
	};
	try {
		const credentials = join(directory, '.zcode', 'v2');
		await mkdir(credentials, { recursive: true });
		const entries: Record<string, string> = {};
		for (const provider of ['bigmodel', 'zai']) {
			const id = `account:${provider}-individual-coding-plan`;
			entries[`account-provider:${id}:identity`] = 'offline-test';
			entries[`account-provider:coding-plan:${id}:account:offline-test:api-key`] = 'offline-test-key';
		}
		await writeFile(join(credentials, 'credentials.json'), JSON.stringify(entries));
		const packageRoot = dirname(dirname(backend));
		metadata.buildId = (JSON.parse(await readFile(join(packageRoot, 'ash-package.json'), 'utf8')) as { buildId: string }).buildId;
		metadata.backendBytes = (await stat(backend)).size;

		for (let index = 0; index < samplesPerCohort; index++) {
			await measure('fresh', index, join(directory, `fresh-profile-${index}`), true);
		}

		stoppedProfile = join(directory, 'stopped-profile');
		setupDesktop = await launchElectron({ appServerMode: 'required', userDataDirectory: join(directory, 'stopped-setup'), profileDirectory: stoppedProfile, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		await setupDesktop.close();
		setupDesktop = undefined;
		await stop(stoppedProfile);
		for (let index = 0; index < samplesPerCohort; index++) {
			await measure('stopped', index, stoppedProfile, true);
		}

		reusedProfile = join(directory, 'reused-profile');
		liveDesktop = await launchElectron({ appServerMode: 'required', userDataDirectory: join(directory, 'reused-setup'), profileDirectory: reusedProfile, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const liveEnvironment = { ...process.env, ASH_HOME: reusedProfile };
		const before = JSON.parse((await execFileAsync(daemon, ['version'], { env: liveEnvironment, windowsHide: true })).stdout) as { pid: number };
		for (let index = 0; index < samplesPerCohort; index++) {
			await measure('reused', index, reusedProfile, false);
		}
		const after = JSON.parse((await execFileAsync(daemon, ['version'], { env: liveEnvironment, windowsHide: true })).stdout) as { pid: number };
		metadata.reusedDaemonSameProcess = before.pid === after.pid;
		await liveDesktop.close();
		liveDesktop = undefined;
		await stop(reusedProfile);

		for (let index = 0; index < samplesPerCohort; index++) {
			await measure('ui-only', index, stoppedProfile, false);
		}
		expect(samples.filter(sample => sample.error)).toEqual([]);
		expect(metadata.reusedDaemonSameProcess).toBe(true);
	} catch (cause) {
		metadata.failure = redact(String(cause), directory, testWorkspace.directory);
		throw cause;
	} finally {
		try {
			let cleanupFailure: unknown;
			for (const desktop of [setupDesktop, liveDesktop]) {
				try { await desktop?.close(); }
				catch (cause) { cleanupFailure ??= cause; }
			}
			for (const profile of [stoppedProfile, reusedProfile]) {
				if (!profile) continue;
				try { await stop(profile); }
				catch (cause) { cleanupFailure ??= cause; }
			}
			if (cleanupFailure) {
				metadata.failure = `Cleanup: ${redact(String(cleanupFailure), directory, testWorkspace.directory)}`;
				throw cleanupFailure;
			}
		} finally {
			const output = join(traceDirectory, 'desktop-startup-trace.json');
			try {
				await mkdir(traceDirectory, { recursive: true });
				await writeFile(output, JSON.stringify({ schemaVersion: 2, metadata, summary: summarize(samples), samples }, null, 2));
				await testInfo.attach('desktop-startup-trace', { path: output, contentType: 'application/json' });
				console.log(`ASH_DESKTOP_STARTUP_TRACE_REPORT ${output}`);
			} finally {
				if (priorHome === undefined) delete process.env.HOME;
				else process.env.HOME = priorHome;
				if (priorUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = priorUserProfile;
				await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	}
});

function redact(value: string, home: string, workspace: string): string {
	return value.replaceAll(home, '[test-home]').replaceAll(workspace, '[test-workspace]').replaceAll(accountHome, '[home]').replaceAll('offline-test-key', '[test-credential]');
}

function summarize(samples: readonly ConnectionSample[]): Record<ConnectionSample['cohort'], { valid: number; errors: number; medianMs: number | null }> {
	return Object.fromEntries((['fresh', 'stopped', 'reused', 'ui-only'] as const).map(cohort => {
		const cohortSamples = samples.filter(sample => sample.cohort === cohort);
		const valid = cohortSamples.flatMap(sample => sample.readyMs === null || sample.error ? [] : [sample.readyMs]).sort((a, b) => a - b);
		const medianMs = valid.length === 0 ? null : (valid[Math.floor((valid.length - 1) / 2)]! + valid[Math.floor(valid.length / 2)]!) / 2;
		return [cohort, { valid: valid.length, errors: cohortSamples.length - valid.length, medianMs }];
	})) as Record<ConnectionSample['cohort'], { valid: number; errors: number; medianMs: number | null }>;
}
