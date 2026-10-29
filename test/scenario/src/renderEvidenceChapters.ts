import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Capture { readonly status?: string; readonly timestamp?: string; readonly details?: string; readonly blockedOn?: string; }
interface Step { readonly id?: string; readonly title?: string; readonly captures?: Capture[]; }
interface Manifest {
	readonly scenarioId?: string;
	readonly title?: string;
	readonly outcome?: string;
	readonly videoStartedAt?: string;
	readonly steps?: Step[];
	artifacts?: { videos?: string[]; };
}
interface Caption { readonly from: number; readonly to: number; readonly eyebrow: string; readonly title: string[]; readonly details: string[]; readonly accent: string; }

const fontCandidates = process.env.CHAPTER_FONT ? [process.env.CHAPTER_FONT] : [
	'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
	'/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
	'/System/Library/Fonts/Supplemental/Arial Bold.ttf',
	'C:/Windows/Fonts/arialbd.ttf',
];

export function resolveVideoTool(tool: 'ffmpeg' | 'ffprobe'): string | undefined {
	const override = process.env[`${tool.toUpperCase()}_PATH`];
	const executable = process.platform === 'win32' ? `${tool}.exe` : tool;
	const candidates = override ? [override] : [tool, ...installedToolCandidates(executable)];
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ['-version'], { stdio: 'ignore' });
			if (tool === 'ffmpeg' && !execFileSync(candidate, ['-hide_banner', '-h', 'filter=drawtext'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('Filter drawtext')) continue;
			return candidate;
		} catch { }
	}
	return undefined;
}

function installedToolCandidates(executable: string): string[] {
	const candidates: string[] = [];
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', executable));
			const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
			for (const packageName of readDirectories(packages).filter(name => /ffmpeg/iu.test(name))) {
				for (const build of readDirectories(join(packages, packageName))) candidates.push(join(packages, packageName, build, 'bin', executable));
			}
		}
		candidates.push(join(process.env.ProgramData ?? '', 'chocolatey', 'bin', executable), join(process.env.ProgramFiles ?? '', 'ffmpeg', 'bin', executable));
	} else {
		candidates.push(`/opt/homebrew/opt/ffmpeg-full/bin/${executable}`, `/opt/homebrew/bin/${executable}`, `/usr/local/bin/${executable}`, `/usr/bin/${executable}`);
	}
	return candidates.filter(existsSync);
}

function readDirectories(root: string): string[] {
	try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; }
}

export function renderChapters(runRoot: string): void {
	const manifestPath = join(runRoot, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
	const videoStartedAt = Date.parse(manifest.videoStartedAt ?? '');
	const rawVideos = (manifest.artifacts?.videos ?? []).filter(video => extname(video).toLowerCase() === '.webm');
	if (rawVideos.length !== 1) {
		console.log(rawVideos.length ? `The run has ${rawVideos.length} recordings; one caption timeline cannot represent multiple windows.` : 'No recorded video is available.');
		return;
	}
	if (!Number.isFinite(videoStartedAt)) {
		console.log('The run has no video start time, so captions cannot be aligned.');
		return;
	}
	const font = fontCandidates.find(candidate => candidate && existsSync(candidate));
	if (!font) throw new Error('No caption font could be found. Set CHAPTER_FONT to a TrueType font.');
	const ffmpeg = resolveVideoTool('ffmpeg');
	const ffprobe = resolveVideoTool('ffprobe');
	if (!ffmpeg || !ffprobe) throw new Error(`${[!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' and ')} could not be found`);

	const inputPath = join(runRoot, rawVideos[0]!);
	const outputRelative = 'videos/annotated.mp4';
	const outputPath = join(runRoot, outputRelative);
	const workDirectory = mkdtempSync(join(tmpdir(), 'ash-evidence-chapters-'));
	try {
		const fontCopy = join(workDirectory, 'font.ttf');
		writeFileSync(fontCopy, readFileSync(font));
		const probe = JSON.parse(execFileSync(ffprobe, [
			'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', inputPath,
		], { encoding: 'utf8' })) as { streams?: { width?: number; height?: number; }[]; format?: { duration?: string; }; };
		const width = Number(probe.streams?.[0]?.width);
		const height = Number(probe.streams?.[0]?.height);
		const duration = Number(probe.format?.duration);
		if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(duration) || duration <= 0) throw new Error('The recorded video could not be probed.');

		const margin = Math.round(width * 0.02);
		const eyebrowSize = Math.max(12, Math.round(height * 0.02));
		const titleSize = Math.max(16, Math.round(height * 0.03));
		const detailSize = Math.max(11, Math.round(height * 0.018));
		const lineHeight = (size: number): number => Math.round(size * 1.35);
		const columnsFor = (size: number): number => Math.max(16, Math.floor((width - margin * 3) / (size * 0.52)));
		const boundaries: { readonly step: Step; readonly at: number; }[] = [];
		let previous = 0;
		for (const step of manifest.steps ?? []) {
			const started = step.captures?.find(capture => capture.status === 'started') ?? step.captures?.[0];
			const offset = (Date.parse(started?.timestamp ?? '') - videoStartedAt) / 1000;
			if (!Number.isFinite(offset)) continue;
			const at = Math.min(Math.max(offset, previous), duration);
			boundaries.push({ step, at });
			previous = at;
		}
		if (!boundaries.length) {
			console.log('No step boundaries were derived, so no captions were rendered.');
			return;
		}

		const captions: Caption[] = [];
		if (boundaries[0]!.at > 0.05) {
			captions.push({ from: 0, to: boundaries[0]!.at, eyebrow: 'ASH UI VALIDATION', title: wrap(manifest.title ?? 'UI validation', columnsFor(titleSize), 2), details: wrap(manifest.scenarioId ?? '', columnsFor(detailSize), 1), accent: accentFor(manifest.outcome) });
		}
		boundaries.forEach((boundary, index) => {
			const result = boundary.step.captures?.at(-1);
			const status = result?.status ?? 'started';
			captions.push({
				from: boundary.at,
				to: boundaries[index + 1]?.at ?? duration,
				eyebrow: `STEP ${index + 1} OF ${boundaries.length}   ${String(boundary.step.id ?? '').toUpperCase()}   ${status.toUpperCase()}${result?.blockedOn ? ` - NEEDS ${result.blockedOn.toUpperCase()}` : ''}`,
				title: wrap(boundary.step.title ?? '', columnsFor(titleSize), 2),
				details: wrap(result?.details ?? '', columnsFor(detailSize), 3),
				accent: accentFor(status),
			});
		});

		const titleLines = Math.max(1, ...captions.map(caption => caption.title.length));
		const detailLines = Math.max(0, ...captions.map(caption => caption.details.length));
		const gap = Math.round(height * 0.008);
		let bandHeight = margin + lineHeight(eyebrowSize) + gap + titleLines * lineHeight(titleSize) + (detailLines ? gap + detailLines * lineHeight(detailSize) : 0) + margin;
		bandHeight += bandHeight % 2;
		const filters = [`[0:v]pad=${width}:${height + bandHeight}:0:${bandHeight}:color=0x0D1117[base]`];
		let label = 'base';
		let textIndex = 0;
		const draw = (lines: readonly string[], size: number, y: number, color: string, caption: Caption, align: 'left' | 'right'): void => {
			if (!lines.length || caption.to <= caption.from + 0.05) return;
			const name = `text-${textIndex++}.txt`;
			writeFileSync(join(workDirectory, name), lines.join('\n'));
			const next = `text${textIndex}`;
			filters.push(`[${label}]drawtext=fontfile=font.ttf:textfile=${name}:expansion=none:fontcolor=${color}:fontsize=${size}:line_spacing=${Math.round(size * 0.35)}:x=${align === 'right' ? `w-text_w-${margin}` : margin}:y=${y}:enable='between(t,${caption.from.toFixed(3)},${caption.to.toFixed(3)})'[${next}]`);
			label = next;
		};
		for (const caption of captions) {
			let y = margin;
			draw([caption.eyebrow], eyebrowSize, y, caption.accent, caption, 'left');
			draw([`outcome: ${manifest.outcome ?? 'unknown'}`], eyebrowSize, y, '0x8B949E', caption, 'right');
			y += lineHeight(eyebrowSize) + gap;
			draw(caption.title, titleSize, y, '0xFFFFFF', caption, 'left');
			y += caption.title.length * lineHeight(titleSize) + gap;
			draw(caption.details, detailSize, y, '0xC9D1D9', caption, 'left');
		}
		filters.push(`[${label}]setsar=1,format=yuv420p[out]`);
		mkdirSync(join(runRoot, 'videos'), { recursive: true });
		execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath], { cwd: workDirectory, stdio: ['ignore', 'inherit', 'inherit'] });
		manifest.artifacts ??= {};
		manifest.artifacts.videos = [...new Set([outputRelative, ...(manifest.artifacts.videos ?? [])])];
		writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
		pointReportAtAnnotatedVideo(runRoot, rawVideos[0]!, outputRelative);
		console.log(`Captioned ${boundaries.length} steps into ${outputRelative}`);
	} finally {
		rmSync(workDirectory, { recursive: true, force: true });
	}
}

function accentFor(status: string | undefined): string {
	switch (status) {
		case 'passed': return '0x3FB950';
		case 'failed': return '0xF85149';
		case 'skipped': return '0xD29922';
		default: return '0x58A6FF';
	}
}

function wrap(value: string, limit: number, maxLines: number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const word of value.trim().split(/\s+/u).filter(Boolean)) {
		if (line && `${line} ${word}`.length > limit) { lines.push(line); line = word; }
		else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[\s.,;:]+$/u, '')}...`;
	return kept;
}

function pointReportAtAnnotatedVideo(runRoot: string, rawVideo: string, annotatedVideo: string): void {
	const reportPath = join(runRoot, 'report.html');
	if (!existsSync(reportPath)) return;
	const report = readFileSync(reportPath, 'utf8');
	writeFileSync(reportPath, report.replace(`src="${rawVideo}"`, `src="${annotatedVideo}"`));
}

export function tryRenderChapters(runRoot: string): void {
	try { renderChapters(runRoot); }
	catch (error) { console.warn(`Unable to render evidence captions: ${error instanceof Error ? error.message : String(error)}. The raw recording is unaffected.`); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && basename(process.argv[1] ?? '') === 'renderEvidenceChapters.js') {
	tryRenderChapters(resolve(process.argv[2] ?? process.env.RUN_ROOT ?? '.'));
}
