import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import type { Page } from '@playwright/test';
import { test } from 'mocha';
import { installClock } from './clock.js';

interface ClockController {
	install(time: number): void;
	setFixedTime(time: number): void;
	setSystemTime(time: number): void;
	pauseAt(time: number): Promise<number>;
	resume(): void;
	runFor(ticks: number): Promise<void>;
	now(): number;
	performanceNow(): number;
	addTimer(options: { type: 'Timeout' | 'AnimationFrame'; delay: number; func: () => void }): number;
}

// Exercise the installed Playwright clock itself without starting a browser. Its
// packaged injected script is self-contained; a packaging change must fail this fixture.
const require = createRequire(join(process.cwd(), 'package.json'));
const testRequire = createRequire(require.resolve('@playwright/test/package.json'));
const playwrightRequire = createRequire(testRequire.resolve('playwright/package.json'));
const bundle = readFileSync(playwrightRequire.resolve('playwright-core/lib/coreBundle'), 'utf8');
const sourceStart = bundle.indexOf('// packages/playwright-core/src/generated/clockSource.ts');
assert.notEqual(sourceStart, -1);
const assignment = /^\s*source = (.+);$/m.exec(bundle.slice(sourceStart));
assert.ok(assignment);
const source = runInNewContext(assignment[1]!) as string;
const Controller = runInNewContext(`${source}; module.exports.ClockController()`, { module: {}, console }) as new (embedder: {
	dateNow(): number;
	performanceNow(): number;
	setTimeout(callback: () => void, delay?: number): () => void;
}) => ClockController;

test('an installed running Playwright clock rejects a pause target that becomes past during transport', async () => {
	const fixture = createClockFixture();
	await fixture.page.clock.install({ time: 10_000 });
	await assert.rejects(fixture.page.clock.pauseAt(10_000), /Cannot fast-forward to the past/u);
});

test('manual clock keeps loading timers live and preserves exact animation steps after a delayed pause', async () => {
	const fixture = createClockFixture();
	const pause = await installClock(fixture.page);
	const events: string[] = [];
	fixture.controller.addTimer({ type: 'Timeout', delay: 10, func: () => events.push('loaded') });
	await fixture.advanceRealTime(65_000);
	assert.deepEqual(events, ['loaded']);
	const loadingTicks = fixture.controller.performanceNow();
	await fixture.advanceRealTime(5_000);
	await pause();
	const pausedTime = fixture.controller.now();
	const pausedTicks = fixture.controller.performanceNow();
	assert.equal(pausedTime, Date.UTC(2026, 0, 1));
	assert.ok(pausedTicks >= loadingTicks);
	const frames: number[] = [];
	const frame = (): void => {
		frames.push(fixture.controller.performanceNow() - pausedTicks);
		if (frames.length < 3) fixture.controller.addTimer({ type: 'AnimationFrame', delay: 16, func: frame });
	};
	fixture.controller.addTimer({ type: 'AnimationFrame', delay: 16, func: frame });
	fixture.controller.addTimer({ type: 'Timeout', delay: 50, func: () => events.push('timeout') });
	await fixture.advanceRealTime(90_000);
	assert.deepEqual({ time: fixture.controller.now(), ticks: fixture.controller.performanceNow(), events, frames }, {
		time: pausedTime, ticks: pausedTicks, events: ['loaded'], frames: [],
	});
	await fixture.page.clock.runFor(49);
	assert.deepEqual({ events, frames }, { events: ['loaded'], frames: [16, 32, 48] });
	await fixture.page.clock.runFor(1);
	assert.deepEqual({ time: fixture.controller.now(), ticks: fixture.controller.performanceNow(), events }, {
		time: pausedTime + 50, ticks: pausedTicks + 50, events: ['loaded', 'timeout'],
	});
});

function createClockFixture() {
	let realTime = 0;
	const tasks = new Set<{ at: number; callback: () => void }>();
	const controller = new Controller({
		dateNow: () => realTime,
		performanceNow: () => realTime,
		setTimeout: (callback, delay) => {
			// Playwright yields between fake callbacks without advancing its timer clock.
			if (delay === undefined) { queueMicrotask(callback); return () => {}; }
			const task = { at: realTime + delay, callback };
			tasks.add(task);
			return () => { tasks.delete(task); };
		},
	});
	controller.resume();
	async function advanceRealTime(milliseconds: number): Promise<void> {
		realTime += milliseconds;
		for (const task of [...tasks]) {
			if (task.at <= realTime) { tasks.delete(task); task.callback(); }
		}
		await setImmediate();
	}
	async function transport(action: () => void | Promise<unknown>): Promise<void> {
		await advanceRealTime(250);
		await action();
		await advanceRealTime(250);
	}
	const page = { clock: {
		install: ({ time }: { time: number }) => transport(() => controller.install(time)),
		setFixedTime: (time: number) => transport(() => controller.setFixedTime(time)),
		pauseAt: (time: number) => transport(() => controller.pauseAt(time)),
		setSystemTime: (time: number) => transport(() => controller.setSystemTime(time)),
		runFor: (ticks: number) => transport(() => controller.runFor(ticks)),
	} } as unknown as Pick<Page, 'clock'>;
	return { controller, page, advanceRealTime };
}
