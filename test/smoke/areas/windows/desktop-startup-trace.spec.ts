import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, homedir, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { launchElectron, type ElectronLaunchMilestone, type ElectronLaunchResult } from '../../../automation/playwrightElectron.js';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';

const execFileAsync = promisify(execFile);
const samplesPerCohort = process.env.ASH_DESKTOP_STARTUP_PROFILE === '1' ? 1 : 5;
const accountHome = homedir();

interface RustTrace {
	readonly traceId: string;
	readonly carrierPid: number;
	readonly pid: number;
	readonly scope: 'connection' | 'probe';
	readonly phase: string;
	readonly durationMs: number;
}

interface ConnectionSample {
	readonly cohort: 'fresh' | 'stopped' | 'reused' | 'ui-only';
	readonly index: number;
	readonly readyMs: number | null;
	readonly milestones: readonly { phase: 'launch-requested' | ElectronLaunchMilestone; elapsedMs: number; }[];
	readonly renderer: { readonly responseEndMs: number; readonly marks: readonly { name: string; startTimeMs: number; detail?: unknown; }[]; } | null;
	readonly main: readonly { name: string; startTimeMs: number; detail: unknown; }[];
	readonly rust: readonly RustTrace[];
	readonly connectionHealthCheck: 'initialize' | 'control' | null;
	readonly firstUse: { readonly editorMs: number | null; readonly quickAccessMs: number; } | null;
	readonly error?: string;
}

test('Desktop startup trace', { tag: '@electron-app-server' }, async ({ target, testWorkspace }, testInfo) => {
	test.skip(process.env.ASH_DESKTOP_STARTUP_TRACE !== '1' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Run explicitly to measure Desktop startup.');
	test.setTimeout(240_000);
	const directory = await mkdtemp(join(tmpdir(), 'ash-trace-'));
	const priorHome = process.env.HOME;
	const priorUserProfile = process.env.USERPROFILE;
	process.env.HOME = directory;
	process.env.USERPROFILE = directory;
	const appPath = resolve(import.meta.dirname, '../../../..');
	const traceDirectory = resolve(appPath, '.build/startup-trace', `desktop-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`);
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
		rendererBuildId: undefined,
		backendBytes: undefined,
		// Historical report field, independent of application startup inputs.
		workbenchMode: 'code',
		workspace: 'isolated test workspace',
		credentialFixture: 'offline test credentials',
		readiness: 'document complete, visible Workbench and editor group, two animation frames',
		measurement: 'one Playwright worker clock, immediately before launchElectron through Workbench ready',
		cache: 'new user data for every sample; operating-system file cache is not cleared',
		profileState: 'fresh profiles include Playwright trust selection; stopped, reused, and UI-only use an authorized profile',
		milestoneClock: 'Playwright worker performance.now; each elapsed time is relative to launch-requested in the same process',
		rendererClock: 'Renderer performance timeline; source-owned startup marks v2 and navigation responseEnd share one window clock',
		rustClock: 'Local Rust Instant durations; Renderer nonce -> Main carrier PID -> per-launch trace ID; probe scope is separate, nested durations are not additive',
		connectionClock: 'Main performance timeline; nonce correlates the same Renderer port lease, clocks are never subtracted across processes',
		cpuProfiles: process.env.ASH_DESKTOP_STARTUP_PROFILE === '1' ? 'first sample per cohort, separate diagnostic run' : 'disabled',
		firstUse: 'post-readiness first main.ts open through asserted text, then titlebar command search and > through visible command option; diagnostics afterward; Playwright worker clock',
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
		let renderer: ConnectionSample['renderer'] = null;
		let main: ConnectionSample['main'] = [];
		let rust: RustTrace[] = [];
		let connectionHealthCheck: ConnectionSample['connectionHealthCheck'] = null;
		let firstUse: ConnectionSample['firstUse'] = null;
		const profileCpu = process.env.ASH_DESKTOP_STARTUP_PROFILE === '1' && index === 0;
		const cpuTrace = join(traceDirectory, `${cohort}-${index}.trace.json`);
		let error: string | undefined;
		const milestones: { phase: 'launch-requested' | ElectronLaunchMilestone; elapsedMs: number; }[] = [{ phase: 'launch-requested', elapsedMs: 0 }];
		try {
			if (profileCpu) await mkdir(traceDirectory, { recursive: true });
			desktop = await launchElectron({
				appServerMode: cohort === 'ui-only' ? 'disabled' : 'required',
				userDataDirectory: join(directory, `${cohort}-${index}`),
				profileDirectory: profile,
				workspaceDirectory: testWorkspace.directory,
				workspacePermissions: cohort === 'fresh' ? 'development' : undefined,
				extraArgs: profileCpu ? ['--trace-startup=devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.cpu_profiler', '--trace-startup-format=json', '--trace-startup-duration=1', `--trace-startup-file=${cpuTrace}`] : undefined,
			}, phase => milestones.push({ phase, elapsedMs: Math.round(performance.now() - start) }));
			readyMs = Math.round(performance.now() - start);
			renderer = await desktop.driver.workbench.page.evaluate(() => {
				const navigation = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
				if (!navigation) throw new Error('Desktop navigation timing is unavailable');
				return {
					responseEndMs: navigation.responseEnd,
					marks: window.performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('ash.')).map(mark => ({ name: mark.name.replace(/^(ash\.appServer\.port-(?:acquire-start|acquired|initialized)):[\da-f-]{36}$/u, '$1'), startTimeMs: mark.startTime, detail: (mark as PerformanceMark).detail })),
				};
			});
			main = await desktop.application.evaluate(() => performance.getEntriesByType('mark')
				.filter(mark => mark.name.startsWith('ash.appServer.main.'))
				.map(mark => ({ name: mark.name, startTimeMs: mark.startTime, detail: (mark as PerformanceMark).detail })));

			const workbench = desktop.driver.workbench;
			let editorMs: number | null = null;
			if (cohort !== 'ui-only') {
				const showSidebar = workbench.page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
				if (await showSidebar.isVisible()) await showSidebar.click();
				const file = workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
				await expect(file).toHaveCount(1);
				const editorStart = performance.now();
				await file.dblclick();
				await expect(workbench.page.locator('.stanza-editor-line-text').first()).toContainText('const value = 1;');
				editorMs = performance.now() - editorStart;
			}
			const quickAccessStart = performance.now();
			await workbench.page.locator('.ash-titlebar-command-center-button').click();
			await expect(workbench.quickaccess.input).toBeFocused();
			await workbench.quickaccess.input.fill('>');
			await expect(workbench.quickaccess.items.first()).toBeVisible();
			firstUse = { editorMs, quickAccessMs: performance.now() - quickAccessStart };
			await workbench.quickaccess.close();

			if (cohort !== 'ui-only') {
				const nonce = (renderer.marks.find(mark => mark.name === 'ash.appServer.port-acquire-start')?.detail as { nonce?: string; } | undefined)?.nonce;
				const initialized = main.find(mark => mark.name === 'ash.appServer.main.initialized' && (mark.detail as { nonce?: string; }).nonce === nonce)?.detail as { carrierPid?: number; carrierTrace?: string[]; } | undefined;
				const carrier = (initialized?.carrierTrace ?? []).flatMap(line => parseRustTrace(line) ?? []);
				const traceIds = new Set(carrier.filter(record => record.pid === initialized?.carrierPid && record.carrierPid === initialized?.carrierPid).map(record => record.traceId));
				expect(traceIds.size, 'one trace ID for the current carrier').toBe(1);
				const traceId = [...traceIds][0];
				connectionHealthCheck = carrier.some(record => record.phase === 'control-contract') ? 'control' : 'initialize';
				// Collect after every measured operation so diagnostics cannot warm first use.
				const status = JSON.parse((await execFileAsync(daemon, ['version'], { env: { ...process.env, ASH_HOME: profile }, windowsHide: true, timeout: 30_000 })).stdout) as { logPath: string; pid: number; };
				const managed = (await readFile(status.logPath, 'utf8')).split('\n').flatMap(line => parseRustTrace(line) ?? []);
				rust = [...carrier, ...managed].filter(record => record.traceId === traceId && record.carrierPid === initialized?.carrierPid);
				expect(rust.filter(record => record.pid !== initialized?.carrierPid).every(record => record.pid === status.pid)).toBe(true);
			}

			if (profileCpu) await expect.poll(() => stat(cpuTrace).then(file => file.size, () => 0), { timeout: 5_000 }).toBeGreaterThan(0);
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
			samples.push({ cohort, index, readyMs, milestones, renderer, main, rust, connectionHealthCheck, firstUse, ...(error ? { error } : {}) });
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
		metadata.buildId = (JSON.parse(await readFile(join(packageRoot, 'ash-package.json'), 'utf8')) as { buildId: string; }).buildId;
		const rendererMetrics = await readFile(resolve(appPath, '.build/desktop/renderer/ash/build-metrics.json'));
		metadata.rendererBuildId = `sha256:${createHash('sha256').update(rendererMetrics).update(await readFile(resolve(appPath, '.build/desktop/renderer/ash/build-assets.json'))).digest('hex')}`;
		metadata.staticJavaScript = (JSON.parse(rendererMetrics.toString()) as { entry: string; staticJavaScriptBytes: number; }[]).map(({ entry, staticJavaScriptBytes }) => ({ entry, staticJavaScriptBytes }));
		metadata.sourceRevision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: appPath })).stdout.trim();
		metadata.sourceDiffSha256 = createHash('sha256').update((await execFileAsync('git', ['diff', 'HEAD'], { cwd: appPath, maxBuffer: 16 * 1024 * 1024 })).stdout).digest('hex');
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
		const before = JSON.parse((await execFileAsync(daemon, ['version'], { env: liveEnvironment, windowsHide: true })).stdout) as { pid: number; };
		for (let index = 0; index < samplesPerCohort; index++) {
			await measure('reused', index, reusedProfile, false);
		}
		const after = JSON.parse((await execFileAsync(daemon, ['version'], { env: liveEnvironment, windowsHide: true })).stdout) as { pid: number; };
		metadata.reusedDaemonSameProcess = before.pid === after.pid;
		await liveDesktop.close();
		liveDesktop = undefined;
		await stop(reusedProfile);

		for (let index = 0; index < samplesPerCohort; index++) {
			await measure('ui-only', index, stoppedProfile, false);
		}
		expect(samples.filter(sample => sample.error)).toEqual([]);
		expect(samples.filter(sample => !sample.renderer?.marks.some(mark => mark.name === 'ash.workbench.restored'))).toEqual([]);
		expect(samples.filter(sample => !sample.renderer?.marks.some(mark => mark.name === 'ash.desktop.lifecycle-ready'))).toEqual([]);
		expect(metadata.reusedDaemonSameProcess).toBe(true);
		for (const sample of samples.filter(sample => sample.cohort !== 'ui-only' && !sample.error)) {
			const port = sample.renderer?.marks.find(mark => mark.name === 'ash.appServer.port-acquire-start')?.detail as { nonce?: string; } | undefined;
			expect(port?.nonce).toBeTruthy();
			const connected = sample.main.filter(mark => (mark.detail as { nonce?: string; }).nonce === port?.nonce);
			for (const phase of ['acquire', 'validated', 'carrier-ready', 'port-attached', 'first-write', 'first-read', 'initialized']) {
				expect(connected.some(mark => mark.name === `ash.appServer.main.${phase}`), `${sample.cohort}[${sample.index}] Main ${phase}`).toBe(true);
			}
			const carrierPid = (connected.find(mark => mark.name === 'ash.appServer.main.carrier-ready')?.detail as { carrierPid?: number; } | undefined)?.carrierPid;
			for (const phase of ['operation-lock', 'install-selection', 'executable-sha256', 'ensure-selected', 'daemon-probe', 'connect-ready']) {
				expect(sample.rust.some(record => record.pid === carrierPid && record.scope === 'connection' && record.phase === phase), `${sample.cohort}[${sample.index}] carrier ${phase}`).toBe(true);
			}
			if (sample.connectionHealthCheck === 'control') expect(sample.rust.some(record => record.scope === 'probe')).toBe(false);
			for (const scope of sample.connectionHealthCheck === 'control' ? ['connection'] : ['probe', 'connection']) {
				for (const phase of ['directory-open', 'initialize']) {
					expect(sample.rust.some(record => record.pid !== carrierPid && record.scope === scope && record.phase === phase), `${sample.cohort}[${sample.index}] server ${scope} ${phase}`).toBe(true);
				}
			}
			if (sample.cohort !== 'reused') expect(sample.rust.some(record => record.pid !== carrierPid && record.phase === 'managed-startup')).toBe(true);
		}
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
				await writeFile(output, JSON.stringify({ schemaVersion: 3, metadata, summary: summarize(samples), samples }, null, 2));
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

function summarize(samples: readonly ConnectionSample[]): Record<ConnectionSample['cohort'], { valid: number; errors: number; medianMs: number | null; }> {
	return Object.fromEntries((['fresh', 'stopped', 'reused', 'ui-only'] as const).map(cohort => {
		const cohortSamples = samples.filter(sample => sample.cohort === cohort);
		const valid = cohortSamples.flatMap(sample => sample.readyMs === null || sample.error ? [] : [sample.readyMs]).sort((a, b) => a - b);
		const medianMs = valid.length === 0 ? null : (valid[Math.floor((valid.length - 1) / 2)]! + valid[Math.floor(valid.length / 2)]!) / 2;
		return [cohort, { valid: valid.length, errors: cohortSamples.length - valid.length, medianMs }];
	})) as Record<ConnectionSample['cohort'], { valid: number; errors: number; medianMs: number | null; }>;
}


/** Diagnostic stderr is a process boundary. Persist only this bounded credential-free shape. */
function parseRustTrace(line: string): RustTrace | undefined {
	if (!line.startsWith('ASH_STARTUP_TRACE ')) return undefined;
	if (line.length > 2048) throw new Error('Oversized Rust startup trace');
	const value: unknown = JSON.parse(line.slice('ASH_STARTUP_TRACE '.length));
	if (!value || typeof value !== 'object') throw new Error('Invalid Rust startup trace');
	const record = value as Record<string, unknown>;
	if (typeof record.traceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(record.traceId)
		|| typeof record.carrierPid !== 'number' || !Number.isSafeInteger(record.carrierPid) || record.carrierPid <= 0
		|| typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0
		|| !['connection', 'probe'].includes(record.scope as string)
		|| typeof record.phase !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(record.phase)
		|| typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0) throw new Error('Invalid Rust startup trace');
	return { traceId: record.traceId, carrierPid: record.carrierPid, pid: record.pid, scope: record.scope as RustTrace['scope'], phase: record.phase, durationMs: record.durationMs };
}
