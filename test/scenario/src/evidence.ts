import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ApplicationService, type JSONValue, type RunningApplication } from './application.ts';

export type StepStatus = 'started' | 'passed' | 'failed' | 'skipped';
export type StepBlocker = 'human' | 'infrastructure';
export type RunOutcome = 'passed' | 'failed' | 'aborted';

interface EvidenceCapture {
	readonly status: StepStatus;
	readonly timestamp: string;
	readonly screenshot: string;
	readonly windowUrl: string;
	readonly details?: string;
	readonly blockedOn?: StepBlocker;
}

interface EvidenceStep {
	readonly id: string;
	readonly title: string;
	readonly captures: EvidenceCapture[];
}

interface EvidenceRun {
	readonly id: string;
	readonly scenarioId: string;
	readonly title: string;
	readonly source?: string;
	readonly scenarioPath?: string;
	readonly workspacePath?: string;
	readonly startedAt: string;
	videoStartedAt?: string;
	completedAt?: string;
	outcome?: RunOutcome;
	notes?: string;
	readonly runPath: string;
	readonly application: RunningApplication;
	readonly steps: EvidenceStep[];
	readonly artifacts: { report?: string; videos: string[]; logs: string[]; finalizationError?: string; };
}

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const evidenceRoot = join(repositoryRoot, '.build', 'ash-playwright-mcp', 'evidence');

export class EvidenceService {
	private currentRun: EvidenceRun | undefined;

	constructor(private readonly applications: ApplicationService) { }

	async start(
		scenarioId: string,
		title: string,
		source?: string,
		scenarioPath?: string,
		workspacePath?: string,
		userSettings?: Readonly<Record<string, JSONValue>>,
		extraArgs?: readonly string[],
	): Promise<string> {
		if (this.currentRun) throw new Error(`Evidence run '${this.currentRun.id}' is already active.`);
		if (source && !isHttpUrl(source)) throw new Error(`Evidence source must use HTTP or HTTPS: '${source}'.`);
		const startedAt = new Date().toISOString();
		const id = `${sanitizePathSegment(scenarioId)}-${startedAt.replace(/[:.]/gu, '-')}`;
		const runPath = join(evidenceRoot, id);
		await mkdir(runPath, { recursive: true });
		const application = await this.applications.start({ runPath, workspacePath, userSettings, extraArgs });
		const run: EvidenceRun = {
			id,
			scenarioId,
			title,
			source,
			scenarioPath,
			workspacePath,
			startedAt,
			videoStartedAt: application.videoStartedAt ? new Date(application.videoStartedAt).toISOString() : undefined,
			runPath,
			application,
			steps: [],
			artifacts: { videos: [], logs: [] },
		};
		this.currentRun = run;
		try {
			await application.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
			await wait(350);
			await this.capture('00-scenario-started.png');
			this.writeManifest();
			return runPath;
		} catch (error) {
			this.currentRun = undefined;
			await application.close().catch(() => undefined);
			await application.dispose().catch(() => undefined);
			throw error;
		}
	}

	async step(id: string, title: string, status: StepStatus, details?: string, blockedOn?: StepBlocker): Promise<void> {
		const run = this.requireRun();
		let step = run.steps.find(candidate => candidate.id === id);
		if (status === 'started') {
			if (step) throw new Error(`Step '${id}' has already started.`);
			const active = run.steps.find(candidate => candidate.captures.at(-1)?.status === 'started');
			if (active) throw new Error(`Step '${active.id}' is still active.`);
			step = { id, title, captures: [] };
			run.steps.push(step);
		} else if (!step || step.captures.at(-1)?.status !== 'started') {
			throw new Error(`Step '${id}' must be started before it can be marked '${status}'.`);
		}
		await wait(status === 'started' ? 350 : 200);
		const sequence = String(run.steps.indexOf(step) + 1).padStart(2, '0');
		const screenshot = `${sequence}-${sanitizePathSegment(id)}-${status}.png`;
		await this.capture(screenshot);
		step.captures.push({ status, timestamp: new Date().toISOString(), screenshot, windowUrl: run.application.page.url(), details, blockedOn });
		this.writeManifest();
	}

	async finish(outcome: RunOutcome, notes?: string): Promise<string> {
		const run = this.requireRun();
		const failedStep = run.steps.find(step => step.captures.at(-1)?.status === 'failed');
		if (failedStep && outcome === 'passed') {
			outcome = 'failed';
			notes = [notes, `Run marked failed because step '${failedStep.id}' failed.`].filter(Boolean).join('\n');
		}
		try {
			if (!run.application.page.isClosed()) {
				await wait(350);
				await this.capture(`99-result-${outcome}.png`);
			}
			run.completedAt = new Date().toISOString();
			run.outcome = outcome;
			run.notes = notes;
			this.writeManifest();

			const videos = [...run.application.videoFiles()];
			const tracePath = join(run.runPath, 'logs', 'trace.zip');
			await mkdir(join(run.runPath, 'logs'), { recursive: true });
			await mkdir(join(run.runPath, 'videos'), { recursive: true });
			await run.application.context.tracing.stop({ path: tracePath });
			run.artifacts.logs.push('logs/trace.zip');
			const videoSave = this.saveVideos(videos);
			await this.applications.stop();
			await videoSave;
			await this.writeDiagnostics();
			await rm(join(run.runPath, '.recordings'), { recursive: true, force: true });
			const reportPath = this.writeReport();
			run.artifacts.report = toRelativePath(run.runPath, reportPath);
			this.writeManifest();
			return reportPath;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			run.completedAt ??= new Date().toISOString();
			run.outcome = 'failed';
			run.artifacts.finalizationError = message;
			run.notes = [notes, `Evidence finalization failed: ${message}`].filter(Boolean).join('\n');
			this.writeManifest();
			throw error;
		} finally {
			await this.applications.stop().catch(() => undefined);
			await run.application.dispose().catch(() => undefined);
			this.currentRun = undefined;
		}
	}

	private async capture(name: string): Promise<void> {
		const run = this.requireRun();
		await run.application.page.screenshot({ path: join(run.runPath, name) });
	}

	private async saveVideos(videos: readonly ReturnType<RunningApplication['videoFiles']>[number][]): Promise<void> {
		const run = this.requireRun();
		await Promise.all(videos.map(async (video, index) => {
			const relativePath = `videos/recording-${index + 1}.webm`;
			await video.saveAs(join(run.runPath, relativePath));
			run.artifacts.videos.push(relativePath);
		}));
	}

	private async writeDiagnostics(): Promise<void> {
		const run = this.requireRun();
		if (!run.application.diagnosticMessages.length) return;
		const relativePath = 'logs/workbench.log';
		await writeFile(join(run.runPath, relativePath), `${run.application.diagnosticMessages.join('\n')}\n`, 'utf8');
		run.artifacts.logs.push(relativePath);
	}

	private writeManifest(): void {
		const run = this.requireRun();
		writeFileSync(join(run.runPath, 'manifest.json'), `${JSON.stringify({
			id: run.id,
			scenarioId: run.scenarioId,
			title: run.title,
			source: run.source,
			scenarioPath: run.scenarioPath,
			workspacePath: run.workspacePath,
			startedAt: run.startedAt,
			videoStartedAt: run.videoStartedAt,
			completedAt: run.completedAt,
			outcome: run.outcome,
			notes: run.notes,
			environment: {
				platform: process.platform,
				architecture: process.arch,
				nodeVersion: process.version,
				ashVersion: readAshVersion(),
				target: run.application.target,
				commit: process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION,
			},
			artifacts: run.artifacts,
			steps: run.steps,
		}, undefined, 2)}\n`);
	}

	private writeReport(): string {
		const run = this.requireRun();
		const rows = run.steps.map(step => {
			const result = step.captures.at(-1);
			const screenshots = step.captures.map(capture => `<a href="${escapeHtml(capture.screenshot)}">${escapeHtml(capture.status)}</a>`).join(', ');
			const blocker = result?.blockedOn ? ` <span class="blocked">(needs ${escapeHtml(result.blockedOn)})</span>` : '';
			return `<tr><td>${escapeHtml(step.id)}</td><td>${escapeHtml(step.title)}</td><td class="${escapeHtml(result?.status ?? '')}">${escapeHtml(result?.status ?? 'unknown')}${blocker}</td><td>${screenshots}</td><td>${escapeHtml(result?.details ?? '')}</td></tr>`;
		}).join('');
		const blocked = run.steps.flatMap(step => {
			const capture = step.captures.at(-1);
			return capture?.blockedOn ? [{ step, capture }] : [];
		});
		const blockedSection = blocked.length
			? `<h2>Needs attention</h2><ul>${blocked.map(({ step, capture }) => `<li><strong>${escapeHtml(step.id)}</strong> needs ${escapeHtml(capture.blockedOn ?? '')}: ${escapeHtml(capture.details ?? '')}</li>`).join('')}</ul>`
			: '';
		const videos = run.artifacts.videos.length ? run.artifacts.videos.map(video => `<video controls src="${escapeHtml(video)}"></video>`).join('') : '<p>No video file was produced.</p>';
		const logs = run.artifacts.logs.map(log => `<li><a href="${escapeHtml(log)}">${escapeHtml(log)}</a></li>`).join('');
		const report = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(run.title)}</title>
<style>body{font:14px system-ui;margin:32px;max-width:1200px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#eee}video{display:block;max-width:100%;margin:16px 0}.passed{color:#187b34}.failed{color:#b42318}.skipped,.blocked{color:#8a6100}.blocked{font-weight:600}</style></head>
<body><h1>${escapeHtml(run.title)}</h1><p><strong>Scenario:</strong> ${escapeHtml(run.scenarioId)}<br><strong>Outcome:</strong> <span class="${escapeHtml(run.outcome ?? '')}">${escapeHtml(run.outcome ?? 'unknown')}</span><br><strong>Started:</strong> ${escapeHtml(run.startedAt)}<br><strong>Completed:</strong> ${escapeHtml(run.completedAt ?? '')}</p>
<p><strong>Source:</strong> ${run.source ? `<a href="${escapeHtml(run.source)}">${escapeHtml(run.source)}</a>` : 'Not recorded'}<br><strong>Workspace:</strong> ${escapeHtml(run.workspacePath ?? 'Not specified')}<br><strong>Environment:</strong> ${escapeHtml(`${process.platform} ${process.arch}; Ash ${readAshVersion()}; ${run.application.target}; Node ${process.version}`)}</p>
<p>${escapeHtml(run.notes ?? '')}</p><h2>Steps</h2><table><thead><tr><th>ID</th><th>Title</th><th>Result</th><th>Screenshots</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>
${blockedSection}<h2>Video</h2>${videos}<h2>Trace and logs</h2>${logs ? `<ul>${logs}</ul>` : '<p>No trace or log content was produced.</p>'}</body></html>`;
		const reportPath = join(run.runPath, 'report.html');
		writeFileSync(reportPath, report);
		return reportPath;
	}

	private requireRun(): EvidenceRun {
		if (!this.currentRun) throw new Error('No evidence run is active.');
		return this.currentRun;
	}
}

function sanitizePathSegment(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unnamed';
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function isHttpUrl(value: string): boolean {
	try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function readAshVersion(): string {
	const packagePath = join(repositoryRoot, 'app-ts', 'package.json');
	return existsSync(packagePath) ? (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string; }).version : 'unknown';
}

function toRelativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join('/');
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
}
