import type { Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { PlaywrightApplication, PlaywrightDriver } from '../../../app-ts/test/automation/playwrightDriver.ts';
import type { Workbench } from '../../../app-ts/test/automation/workbench.ts';
import { ApplicationService, type JSONValue } from './application.ts';
import { EvidenceService, type StepBlocker } from './evidence.ts';
import { parseRunnerOptions } from './options.ts';
import { resolveVideoTool, tryRenderChapters } from './renderEvidenceChapters.ts';

export interface ScenarioContext {
	readonly app: PlaywrightApplication;
	readonly driver: PlaywrightDriver;
	readonly code: PlaywrightDriver;
	readonly workbench: Workbench;
	readonly page: Page;
	skip(reason: string, options?: { readonly needs?: StepBlocker }): never;
}

export interface ScenarioStep {
	readonly id: string;
	readonly title: string;
	run(context: ScenarioContext): Promise<string | void> | string | void;
}

export interface Scenario {
	readonly id: string;
	readonly title: string;
	readonly source?: string;
	readonly scenarioPath?: string;
	readonly workspacePath?: string;
	readonly userSettings?: Readonly<Record<string, JSONValue>>;
	readonly extraArgs?: readonly string[];
	readonly stepPauseMs?: number;
	readonly steps: readonly ScenarioStep[];
}

export interface ScenarioBlocker {
	readonly id: string;
	readonly title: string;
	readonly needs: StepBlocker;
	readonly reason: string;
}

class SkipStep extends Error {
	constructor(reason: string, readonly needs?: StepBlocker) { super(reason); }
}

const defaultStepPauseMs = 1_000;
const commandLine = process.argv.slice(2);
const options = parseRunnerOptions(commandLine);

export async function runScenario(scenario: Scenario): Promise<{ readonly runPath: string; readonly outcome: 'passed' | 'failed' | 'aborted'; readonly blockers: readonly ScenarioBlocker[] }> {
	checkVideoTooling();
	validateScenario(scenario);
	const applications = new ApplicationService(options);
	const evidence = new EvidenceService(applications);
	const runPath = await evidence.start(scenario.id, scenario.title, scenario.source, scenario.scenarioPath, scenario.workspacePath, scenario.userSettings, scenario.extraArgs);
	console.log(`Evidence run: ${runPath}`);
	const blockers: ScenarioBlocker[] = [];
	let outcome: 'passed' | 'failed' | 'aborted' = 'passed';
	let notes: string | undefined;
	const pause = Math.max(0, scenario.stepPauseMs ?? defaultStepPauseMs);

	try {
		for (const step of scenario.steps) {
			await evidence.step(step.id, step.title, 'started');
			const running = applications.application;
			if (!running || running.page.isClosed()) throw new Error('Ash is no longer running.');
			const context: ScenarioContext = {
				app: running.application,
				driver: running.driver,
				code: running.driver,
				workbench: running.workbench,
				page: running.page,
				skip: (reason, skipOptions) => { throw new SkipStep(reason, skipOptions?.needs); },
			};
			try {
				const details = await step.run(context);
				await evidence.step(step.id, step.title, 'passed', details || undefined);
				console.log(`  PASS ${step.id} ${step.title}`);
				await wait(pause);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const skipped = error instanceof SkipStep;
				const needs = skipped ? error.needs : undefined;
				await evidence.step(step.id, step.title, skipped ? 'skipped' : 'failed', message, needs);
				console.log(`  ${skipped ? 'SKIP' : 'FAIL'} ${step.id} ${step.title}${needs ? ` [needs ${needs}]` : ''}: ${message}`);
				if (needs) blockers.push({ id: step.id, title: step.title, needs, reason: message });
				outcome = skipped ? 'aborted' : 'failed';
				notes = `${skipped ? 'Skipped' : 'Failed'} at step '${step.id}': ${message}`;
				await wait(pause);
				break;
			}
		}
	} catch (error) {
		outcome = 'failed';
		notes = error instanceof Error ? error.message : String(error);
		console.error(`Scenario aborted: ${notes}`);
	}

	if (blockers.length) notes = [notes, ...blockers.map(blocker => `Step '${blocker.id}' needs ${blocker.needs}: ${blocker.reason}`)].filter(Boolean).join('\n');
	const report = await evidence.finish(outcome, notes);
	tryRenderChapters(runPath);
	console.log(`Report: ${report}`);
	for (const blocker of blockers) {
		console.log(blocker.needs === 'human'
			? `Needs a person: ${blocker.id} ${blocker.title} - ${blocker.reason}`
			: `Needs harness support: ${blocker.id} ${blocker.title} - ${blocker.reason}`);
	}
	return { runPath, outcome, blockers };
}

function validateScenario(scenario: Scenario): void {
	if (!scenario || typeof scenario !== 'object') throw new Error('The scenario module did not export a scenario object.');
	if (!scenario.id || !scenario.title) throw new Error("A scenario must declare non-empty 'id' and 'title' fields.");
	if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error('A scenario must declare at least one step.');
	const ids = new Set<string>();
	for (const step of scenario.steps) {
		if (!step?.id || !step.title || typeof step.run !== 'function') throw new Error("Every step must declare an 'id', 'title', and 'run' function.");
		if (ids.has(step.id)) throw new Error(`Scenario repeats step id '${step.id}'.`);
		ids.add(step.id);
	}
}

async function loadScenario(path: string): Promise<Scenario> {
	const loaded = await import(pathToFileURL(path).href) as { default?: Scenario } & Partial<Scenario>;
	return (loaded.default ?? loaded) as Scenario;
}

function checkVideoTooling(): void {
	const missing = (['ffmpeg', 'ffprobe'] as const).filter(tool => !resolveVideoTool(tool));
	if (!missing.length) return;
	const install = process.platform === 'win32' ? 'winget install Gyan.FFmpeg' : process.platform === 'darwin' ? 'brew install ffmpeg-full' : 'sudo apt install ffmpeg';
	console.warn(`Warning: ${missing.join(' and ')} with caption support could not be found. The raw video, screenshots, trace, and report will still be saved. Install with: ${install}`);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const scenarioArgument = commandLine.find(argument => !argument.startsWith('--'));
	if (!scenarioArgument) {
		console.error('Usage: node test/scenario/out/runScenario.js <scenario.cjs> [--dev] [--web] [--headless] [--verbose]');
		process.exit(2);
	}
	void loadScenario(resolve(scenarioArgument)).then(runScenario).then(result => {
		console.log(`Outcome: ${result.outcome}`);
		process.exit(result.outcome === 'passed' ? 0 : 1);
	}, error => {
		console.error(error instanceof Error ? error.stack ?? error.message : error);
		process.exit(1);
	});
}
