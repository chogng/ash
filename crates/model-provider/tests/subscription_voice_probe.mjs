// Explicit real-account test peer. It sends a synthetic WAV, never captures a microphone.
import { chromium } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const [audioPath, events, route = 'codex', ...extra] = process.argv.slice(2);
if (!audioPath || !['dataChannel', 'sideband'].includes(events) || !['codex', 'desktop'].includes(route) || extra.length) {
	throw new Error('Usage: node crates/model-provider/tests/subscription_voice_probe.mjs <synthetic.wav> <dataChannel|sideband> [codex|desktop]');
}
const audio = await readFile(resolve(audioPath));
if (audio.length > 2 * 1024 * 1024 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
	throw new Error('Provide a bounded synthetic WAV saying: Please delegate this task to the coding assistant. Reply with the word ready. Do not run commands or edit files.');
}
const repository = fileURLToPath(new URL('../../../', import.meta.url));
await mkdir(resolve(repository, '.tmp'), { recursive: true });
const directory = await mkdtemp(resolve(repository, '.tmp/subscription-voice-events-'));
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
let exitCode;
let done;

async function waitFile(name) {
	for (let index = 0; index < 1800; index++) {
		try { await access(resolve(directory, name)); return; } catch { }
		if (exitCode !== undefined) throw new Error(`Probe exited ${exitCode} before ${name}`);
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${name}`);
}

try {
	const page = await browser.newPage();
	await page.exposeFunction('probeEvent', type => console.log(`Voice event: ${type}`));
	const offer = await page.evaluate(async () => {
		const context = new AudioContext();
		await context.resume();
		const destination = context.createMediaStreamDestination();
		// Real RTP starts before attachment, without sending a caller's speech or microphone.
		const silence = context.createOscillator();
		const gain = context.createGain();
		gain.gain.value = 0;
		silence.connect(gain).connect(destination);
		silence.start();
		const peer = new RTCPeerConnection({ iceServers: [] });
		peer.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
		const channel = peer.createDataChannel('oai-events');
		const state = window.voiceProbe = {
			peer, context, destination, channel, inputDone: false, outputDone: false,
			delegated: false, delegationContentValid: false, closeSent: false, sessionClosed: false,
			channelClosed: false, types: [], handled: new Set(), error: undefined,
		};
		channel.onclose = () => { state.channelClosed = true; };
		channel.onmessage = event => {
			if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) { state.error = 'invalid_event_size'; return; }
			let value;
			try { value = JSON.parse(event.data); } catch { state.error = 'invalid_json'; return; }
			if (typeof value.type !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(value.type)) { state.error = 'invalid_event_type'; return; }
			if (!state.types.includes(value.type) && state.types.length < 64) { state.types.push(value.type); void window.probeEvent(value.type); }
			if (value.type === 'error') {
				const code = value.error?.code;
				state.error = typeof code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : 'provider_error';
				// The peer never receives credentials. Still redact identifiers and URLs
				// from a bounded provider explanation before it reaches diagnostic logs.
				if (typeof value.error?.message === 'string') {
					state.errorReason = value.error.message.slice(0, 1000)
						.replace(/https?:\/\/\S+|\S+@\S+|\S{40,}/g, '[redacted]')
						.replace(/[^\x20-\x7e]/g, ' ').slice(0, 400);
				}
			}
			if (value.type === 'turn.done' && typeof value.turn?.transcript === 'string') {
				if (value.turn.role === 'user') state.inputDone = value.turn.transcript.toLowerCase().includes('coding assistant');
				if (value.turn.role === 'assistant' && state.delegated) state.outputDone = Boolean(value.turn.transcript.trim());
			}
			if (value.type === 'delegation.created' && value.item?.target === 'client') {
				const id = value.item.id;
				if (typeof id !== 'string' || !id.length || id.length > 256 || state.handled.size >= 256) { state.error = 'invalid_delegation'; return; }
				if (state.handled.has(id)) return;
				state.handled.add(id);
				state.delegated = true;
				state.delegationContentValid = Array.isArray(value.item.content) && value.item.content.some(item => item.type === 'input_text' && typeof item.text === 'string' && item.text.toLowerCase().includes('ready'));
				channel.send(JSON.stringify({ type: 'delegation.context.append', delegation_item_id: id, channel: 'commentary', content: [{ type: 'input_text', text: 'The synthetic task finished. No commands were run and no files were edited.' }] }));
			}
			if (value.type === 'session.closed') state.sessionClosed = true;
			if (state.inputDone && state.outputDone && state.delegated && !state.closeSent) {
				channel.send(JSON.stringify({ type: 'session.close' }));
				state.closeSent = true;
			}
		};
		await peer.setLocalDescription(await peer.createOffer());
		await new Promise(resolve => {
			if (peer.iceGatheringState === 'complete') return resolve();
			const timer = setTimeout(resolve, 5000);
			peer.addEventListener('icegatheringstatechange', () => {
				if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
			});
		});
		return peer.localDescription.sdp;
	});
	await writeFile(resolve(directory, 'offer.sdp'), offer);
	done = new Promise(resolve => {
		const child = spawn('just', ['test', 'ash-model-provider', 'subscription_voice_transcribes_delegates_and_closes', '--', '--ignored', '--nocapture'], {
			cwd: repository, env: { ...process.env, ASH_TEST_VOICE_DIRECTORY: directory, ASH_TEST_VOICE_EVENTS: events, ASH_TEST_VOICE_ROUTE: route, ASH_TEST_VOICE_SESSION_ID: randomUUID() }, stdio: 'inherit', windowsHide: true,
		});
		child.on('error', () => { exitCode = 1; resolve(); });
		child.on('exit', code => { exitCode = code ?? 1; resolve(); });
	});
	await waitFile('answer.sdp');
	const answer = await readFile(resolve(directory, 'answer.sdp'), 'utf8');
	await page.evaluate(sdp => window.voiceProbe.peer.setRemoteDescription({ type: 'answer', sdp }), answer);
	await page.waitForFunction(() => window.voiceProbe.peer.connectionState === 'connected', null, { timeout: 20000 });
	await page.waitForFunction(async () => [...(await window.voiceProbe.peer.getStats()).values()].some(stat => stat.type === 'outbound-rtp' && stat.kind === 'audio' && stat.packetsSent > 0), null, { timeout: 10000 });
	await writeFile(resolve(directory, 'peer.ready'), 'connected');
	if (events === 'sideband') await waitFile('sideband.ready');
	else {
		try {
			await page.waitForFunction(() => window.voiceProbe.channel.readyState === 'open' || window.voiceProbe.error, null, { timeout: 45000 });
		} catch {
			await page.evaluate(() => { window.voiceProbe.error = 'channel_open_timeout'; });
		}
	}
	await page.evaluate(async bytes => {
		if (window.voiceProbe.error) return;
		const { context, destination } = window.voiceProbe;
		const source = context.createBufferSource();
		source.buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer);
		source.connect(destination);
		source.start();
	}, [...audio]);
	if (events === 'dataChannel') {
		try {
			await page.waitForFunction(() => window.voiceProbe.error || (window.voiceProbe.closeSent && (window.voiceProbe.sessionClosed || window.voiceProbe.channelClosed)), null, { timeout: 45000 });
		} catch { console.log('Voice event deadline reached.'); }
		const report = await page.evaluate(async () => {
			const { inputDone, outputDone, delegated, delegationContentValid, closeSent, sessionClosed, channelClosed, types, error, errorReason, peer } = window.voiceProbe;
			const outputAudioReceived = [...(await peer.getStats()).values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio' && stat.packetsReceived > 0);
			return { inputDone, outputDone, delegated, delegationContentValid, closeSent, sessionClosed, channelClosed, outputAudioReceived, types, error, errorReason, connectionState: peer.connectionState, channelState: window.voiceProbe.channel.readyState };
		});
		console.log(report);
		await writeFile(resolve(directory, 'report.pending'), JSON.stringify(report));
		await rename(resolve(directory, 'report.pending'), resolve(directory, 'report.json'));
	}
	await done;
	if (exitCode !== 0) throw new Error(`Voice protocol verification failed (${exitCode}).`);
} finally {
	// A failed peer tells the test to stop waiting; the ignored test owns the network socket.
	await writeFile(resolve(directory, 'peer.failed'), 'peer stopped');
	await browser.close();
	if (done) await done;
}
