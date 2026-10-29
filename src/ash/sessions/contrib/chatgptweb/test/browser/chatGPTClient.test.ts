import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { chatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { ChatGPTClient, ChatGPTRequestError, decodeChatGPTStream, readChatGPTVoiceUpdate } from '../../browser/chatGPTClient.js';

const signal = (): AbortSignal => new AbortController().signal;
const json = (value: unknown): Response => Response.json(value);
const message = (id: string, role: string, text: string): object => ({
	id,
	author: { role },
	content: { content_type: 'text', parts: [text] },
});
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of values) {
		result.push(value);
	}
	return result;
}

suite('Bundled ChatGPT client', () => {
	test('resumes an accepted background turn without sending another user message or exposing its token', async () => {
		const paths: string[] = [];
		const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
		const client = new ChatGPTClient((async (input, init) => {
			const path = String(input);
			paths.push(path);
			if (path.includes('/.headers/')) {
				return json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			}
			if (path.endsWith('/prepare')) {
				return json({ conduit_token: 'initial-token' });
			}
			if (path.endsWith('/resume')) {
				assert.equal(new Headers(init?.headers).get('x-conduit-token'), 'resume-token');
				assert.deepEqual(JSON.parse(String(init?.body)), { conversation_id: 'chat', offset: 0 });
				// Offset zero replays the original handoff before the actual completion.
				return new Response(
					frame({
						type: 'stream_handoff',
						conversation_id: 'chat',
						options: [{ type: 'resume_sse_endpoint' }],
					}) +
						frame({
							conversation_id: 'chat',
							message: message('reply', 'assistant', 'Completed Pro reply'),
						}) +
						frame({ type: 'message_stream_complete', conversation_id: 'chat' }) +
						'data: [DONE]\n\n',
					{ headers: { 'Content-Type': 'text/event-stream' } },
				);
			}
			return new Response(
				frame({ type: 'resume_conversation_token', token: 'resume-token' }) +
					frame({
						type: 'stream_handoff',
						conversation_id: 'chat',
						options: [{ type: 'resume_sse_endpoint' }],
					}) +
					'data: [DONE]\n\n',
				{ headers: { 'Content-Type': 'text/event-stream' } },
			);
		}) as typeof fetch);
		const updates = await collect(client.send({ text: 'Question', model: 'pro', parentId: 'parent', messageId: 'user' }, signal()));
		assert.equal(updates.at(-1)?.message?.text, 'Completed Pro reply');
		assert.ok(updates.every(update => !('resumeToken' in update)));
		assert.equal(paths.filter(path => path === '/service/backend-api/f/conversation').length, 1);
		assert.equal(paths.filter(path => path.endsWith('/resume')).length, 1);
	});

	test('handoff cancellation never resumes and a resume rejection retains accepted-message semantics', async () => {
		let resumes = 0;
		const client = new ChatGPTClient((async input => {
			const path = String(input);
			if (path.includes('/.headers/')) {
				return json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			}
			if (path.endsWith('/prepare')) {
				return json({ conduit_token: 'initial' });
			}
			if (path.endsWith('/resume')) {
				resumes++;
				return new Response(null, { status: 401 });
			}
			return new Response(
				'data: {"type":"resume_conversation_token","token":"resume"}\n\ndata: {"type":"stream_handoff","conversation_id":"chat","options":[{"type":"resume_sse_endpoint"}]}\n\ndata: [DONE]\n\n',
				{ headers: { 'Content-Type': 'text/event-stream' } },
			);
		}) as typeof fetch);
		const input = { text: 'Question', model: 'pro', parentId: 'parent', messageId: 'user' };
		const controller = new AbortController();
		await assert.rejects(async () => {
			for await (const update of client.send(input, controller.signal)) {
				if (update.conversationId) {
					controller.abort();
				}
			}
		});
		assert.equal(resumes, 0);
		await assert.rejects(collect(client.send(input, signal())), error => error instanceof Error && !(error instanceof ChatGPTRequestError) && /401/u.test(error.message));
		assert.equal(resumes, 1);
	});

	test('loads all project pages when the service rejects oversized sidebar requests', async () => {
		const cursors: (string | null)[] = [];
		const projects = Array.from({ length: 21 }, (_, index) => ({
			id: `project-${index}`,
			title: `Project ${index}`,
		}));
		const client = new ChatGPTClient((async input => {
			const url = new URL(String(input), 'https://fixture.test');
			assert.equal(url.pathname, '/service/backend-api/gizmos/snorlax/sidebar');
			if (Number(url.searchParams.get('limit')) > 20) {
				return new Response(null, { status: 422 });
			}
			const cursor = url.searchParams.get('cursor');
			cursors.push(cursor);
			const page = cursor === null ? projects.slice(0, 20) : projects.slice(20);
			return json({
				items: page.map(project => ({ gizmo: { id: project.id, display: { name: project.title } } })),
				cursor: cursor === null ? 'next-page' : null,
			});
		}) as typeof fetch);
		assert.deepEqual(await client.projects(signal()), projects);
		assert.deepEqual(cursors, [null, 'next-page']);
	});

	test('shows only version families and preserves the five product presets and their request targets', async () => {
		const client = new ChatGPTClient((async () => json(chatGPTModelCatalog())) as typeof fetch);
		const catalog = await client.models(signal());
		assert.equal(catalog.defaultModel, 'latest');
		assert.deepEqual(
			catalog.models.map(model => [model.id, model.title]),
			[
				['latest', 'GPT-6'],
				['5.6', 'GPT-5.6 Sol'],
			],
		);
		assert.deepEqual(catalog.models[0]!.presets, [
			{ id: '0', label: 'Instant', model: 'gpt-6-instant', thinkingEffort: undefined, isPro: false },
			{ id: '1', label: 'Medium', model: 'gpt-6-thinking', thinkingEffort: 'standard', isPro: false },
			{ id: '2', label: 'High', model: 'gpt-6-thinking', thinkingEffort: 'extended', isPro: false },
			{ id: '6', label: 'Extra High', model: 'gpt-6-thinking', thinkingEffort: 'max', isPro: false },
			{ id: '3', label: 'Pro', model: 'gpt-6-pro', thinkingEffort: undefined, isPro: true },
		]);
		assert.equal(catalog.models[0]!.defaultPreset, '0');
	});

	test('identifies Pro by its advertised lane rather than its label or slider position', async () => {
		const source = chatGPTModelCatalog();
		const presets = source.versions[0]!.intelligence_presets;
		source.versions[0]!.intelligence_presets = [
			{ ...presets[4]!, title: 'Maximum compute', selected_display_title: 'Maximum compute' },
			...presets.slice(0, 3),
			{ ...presets[3]!, title: 'Pro', selected_display_title: 'Pro' },
		];
		const client = new ChatGPTClient((async () => json(source)) as typeof fetch);
		const catalog = await client.models(signal());
		assert.deepEqual(
			catalog.models[0]!.presets.map(preset => [preset.label, preset.isPro]),
			[
				['Maximum compute', true],
				['Instant', false],
				['Medium', false],
				['High', false],
				['Pro', false],
			],
		);
	});

	test('rejects unavailable or invalid presets without exposing extra raw models as picker entries', async () => {
		const source = chatGPTModelCatalog();
		const version = source.versions[0]!;
		let value: unknown = {
			...source,
			versions: [
				{
					...version,
					intelligence_presets: [
						...version.intelligence_presets,
						{
							id: 4,
							title: 'Hidden',
							model_slug: 'gpt-6-thinking',
							thinking_effort: 'min',
							preset_type: 'unavailable',
						},
						{ id: 5, title: 'Unknown target', model_slug: 'missing', preset_type: 'available' },
						{
							id: 7,
							title: 'Unsupported effort',
							model_slug: 'gpt-6-thinking',
							thinking_effort: 'xhigh',
							preset_type: 'available',
						},
						{ id: 8, title: '', model_slug: 'gpt-6-instant' },
						{ id: 6, title: 'Duplicate', model_slug: 'gpt-6-pro' },
						null,
					],
				},
				{ ...source.versions[1], enabled: false },
			],
		};
		const client = new ChatGPTClient((async () => json(value)) as typeof fetch);
		const catalog = await client.models(signal());
		assert.deepEqual(
			catalog.models.map(model => model.id),
			['latest'],
		);
		assert.deepEqual(
			catalog.models[0]!.presets.map(preset => preset.id),
			['0', '1', '2', '6', '3'],
		);
		for (const versions of [undefined, []]) {
			value = { ...source, versions };
			await assert.rejects(client.models(signal()), /unsupported response/u);
		}
	});

	test('restores the newest assistant thinking effort only from the selected history branch', async () => {
		const client = new ChatGPTClient((async () =>
			json({
				default_model_slug: 'thinking',
				current_node: 'new',
				mapping: {
					old: {
						parent: null,
						message: {
							...message('old', 'assistant', 'Old reply'),
							metadata: { thinking_effort: 'standard' },
						},
					},
					new: {
						parent: 'old',
						message: { ...message('new', 'assistant', 'New reply'), metadata: { thinking_effort: 'max' } },
					},
					other: {
						parent: 'old',
						message: {
							...message('other', 'assistant', 'Other branch'),
							metadata: { thinking_effort: 'extended' },
						},
					},
				},
			})) as typeof fetch);
		const history = await client.history('chat', signal());
		assert.equal(history.thinkingEffort, 'max');
		assert.deepEqual(
			history.messages.map(message => message.text),
			['Old reply', 'New reply'],
		);
	});

	test('negotiates ChatGPT voice with multipart SDP on the current endpoint', async () => {
		let answer = 'v=0\r\ns=Fixture\r\n';
		const client = new ChatGPTClient((async (url, init) => {
			assert.equal(url, '/service/realtime/vp?dcid=0');
			assert.ok(init?.body instanceof FormData);
			assert.equal(init.body.get('sdp'), 'v=0\r\ns=Offer\r\n');
			const session = JSON.parse(String(init.body.get('session')));
			assert.equal(session.parent_message_id, 'parent');
			assert.equal(session.conversation_id, 'chat-one');
			assert.equal(session.language_code, 'zh-CN');
			assert.equal(session.voice_mode, 'advanced');
			assert.equal(session.enable_message_streaming, true);
			assert.equal(session.voice_training_allowed, false);
			return new Response(answer, { status: 201 });
		}) as typeof fetch);
		const input = { parentId: 'parent', conversationId: 'chat-one', language: 'zh-CN', sdp: 'v=0\r\ns=Offer\r\n' };
		assert.equal(await client.voice(input, signal()), answer);
		for (const invalid of ['{}', 'https://outside.test', 'v=0\n' + 'x'.repeat(128 * 1024)]) {
			answer = invalid;
			await assert.rejects(client.voice(input, signal()), /unsupported response/u);
		}
	});

	test('voice data messages retain canonical message and conversation identities', () => {
		const payload = {
			id: 'spoken-user',
			author: { role: 'user' },
			content: {
				content_type: 'multimodal_text',
				parts: [{ content_type: 'audio_transcription', text: 'Synthetic spoken question', direction: 'in' }],
			},
		};
		assert.deepEqual(
			readChatGPTVoiceUpdate(
				JSON.stringify({
					type: 'data_message',
					data: JSON.stringify({ type: 'full_chat_message', payload: { message: payload } }),
				}),
			),
			{
				conversationId: undefined,
				message: { id: 'spoken-user', role: 'user', text: 'Synthetic spoken question' },
			},
		);
		assert.deepEqual(
			readChatGPTVoiceUpdate(
				JSON.stringify({
					type: 'conversation_update',
					payload: { conversation_id: 'chat-one', parent_message_id: 'voice-reply' },
				}),
			),
			{ conversationId: 'chat-one', parentId: 'voice-reply' },
		);
		assert.equal(readChatGPTVoiceUpdate('{invalid'), undefined);
		assert.equal(readChatGPTVoiceUpdate('x'.repeat(128 * 1024 + 1)), undefined);
	});

	test('voice stop waits for the committed message before returning the next continuation node', async () => {
		let reads = 0;
		const client = new ChatGPTClient((async () => {
			reads++;
			if (reads === 1) {
				return new Response(null, { status: 404 });
			}
			return json({
				current_node: reads === 2 ? 'old' : 'hidden-leaf',
				mapping: {
					old: { parent: null, message: message('old', 'assistant', 'Before voice') },
					...(reads === 2
						? {}
						: {
								'voice-reply': {
									parent: 'old',
									message: {
										id: 'voice-reply',
										author: { role: 'assistant' },
										content: {
											content_type: 'multimodal_text',
											parts: [{ content_type: 'audio_transcription', text: 'Spoken answer' }],
										},
									},
								},
								'hidden-leaf': {
									parent: 'voice-reply',
									message: message('hidden-leaf', 'assistant', ''),
								},
							}),
				},
			});
		}) as typeof fetch);
		const history = await client.voiceHistory('chat-one', 'voice-reply', signal());
		assert.equal(reads, 3);
		assert.equal(history.parentId, 'hidden-leaf');
		assert.equal(history.messages.at(-1)!.text, 'Spoken answer');
	});
	test('retains authenticated resources and source metadata instead of reducing them to web links', async () => {
		const client = new ChatGPTClient((async () =>
			json({
				current_node: 'reply',
				mapping: {
					reply: {
						parent: null,
						message: {
							id: 'reply',
							author: { role: 'assistant' },
							content: {
								content_type: 'multimodal_text',
								parts: [
									'Before',
									{
										content_type: 'image_asset_pointer',
										asset_pointer: 'file-service://file-image',
										alt: 'Diagram',
									},
									'After',
								],
							},
							metadata: {
								attachments: [{ id: 'file-pdf', name: 'report.pdf', mime_type: 'application/pdf' }],
								search_result_groups: [
									{
										entries: [
											{
												ref_id: { turn_index: 2, ref_type: 'search', ref_index: 1 },
												url: 'https://docs.python.org/3/library/csv.html',
												title: 'CSV documentation',
												snippet: 'Read and write tabular data.',
											},
										],
									},
								],
							},
						},
					},
				},
			})) as typeof fetch);
		const reply = (await client.history('conversation', signal())).messages[0]!;
		assert.match(reply.text, /Before\nDiagram\nAfter/u);
		assert.equal(reply.resources?.[0]?.uri, 'file-service://file-image');
		assert.equal(reply.resources?.[1]?.name, 'report.pdf');
		assert.equal(reply.references?.[0]?.id, 'turn2search1');
		assert.equal(reply.references?.[0]?.snippet, 'Read and write tabular data.');
		assert.doesNotMatch(reply.text, /View this content/u);
	});

	test('resolves grouped and single web sources whose reference IDs live in refs arrays', async () => {
		const client = new ChatGPTClient((async () =>
			json({
				current_node: 'reply',
				mapping: {
					reply: {
						parent: null,
						message: {
							...message('reply', 'assistant', 'Reference'),
							metadata: {
								content_references: [
									{
										type: 'url',
										item: {
											title: 'CSV',
											url: 'https://docs.python.org/3/library/csv.html',
											refs: [{ turn_index: 0, ref_type: 'search', ref_index: 0 }],
										},
									},
									{
										type: 'grouped_webpages',
										items: [
											{
												title: 'Writer',
												url: 'https://docs.python.org/3/library/csv.html?highlight=writerow',
												snippet: 'Writer documentation',
												refs: [{ turn_index: 0, ref_type: 'search', ref_index: 1 }],
											},
										],
									},
									{ items: [{ url: 'javascript:alert(1)', refs: ['turn0search2'] }] },
								],
							},
						},
					},
				},
			})) as typeof fetch);
		const reply = (await client.history('conversation', signal())).messages[0]!;
		assert.deepEqual(
			reply.references?.map(reference => [reference.id, reference.title, reference.snippet]),
			[
				['turn0search0', 'CSV', ''],
				['turn0search1', 'Writer', 'Writer documentation'],
			],
		);
	});

	test('resolves a sandbox file through the web download endpoint and signed resource bytes', async () => {
		const requests: string[] = [];
		const client = new ChatGPTClient((async input => {
			const url = new URL(String(input), 'https://fixture.test');
			requests.push(url.searchParams.get('url')!);
			return requests.length === 1
				? json({ download_url: 'https://files.oaiusercontent.com/file-test?signature=fixture' })
				: new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
		}) as typeof fetch);
		const blob = await client.readResource('sandbox:/mnt/data/test.png', 'conversation', 'reply', signal());
		assert.equal(blob.type, 'image/png');
		assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
		const web = new URL(requests[0]!);
		assert.equal(web.origin, 'https://chatgpt.com');
		assert.equal(web.searchParams.get('message_id'), 'reply');
		assert.equal(web.searchParams.get('sandbox_path'), '/mnt/data/test.png');
		assert.equal(requests[1], 'https://files.oaiusercontent.com/file-test?signature=fixture');
	});
	test('reads only the selected branch and sends its actual parent and model', async () => {
		const calls: { path: string; init: RequestInit }[] = [];
		const client = new ChatGPTClient((async (url, init = {}) => {
			const path = String(url);
			calls.push({ path, init });
			if (path.includes('/.headers/')) {
				return json({
					'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-requirements',
					'OpenAI-Sentinel-Proof-Token': 'fixture-proof',
					'OpenAI-Sentinel-Turnstile-Token': 'fixture-vm',
				});
			}
			if (path.endsWith('/f/conversation/prepare')) {
				return json({ status: 'ready', conduit_token: 'synthetic-conduit' });
			}
			if (path.endsWith('/conversation/chat-one')) {
				return json({
					title: 'Chosen branch',
					current_node: 'reply-two',
					mapping: {
						root: { parent: null },
						user: { parent: 'root', message: message('user', 'user', 'Question') },
						'reply-one': { parent: 'user', message: message('reply-one', 'assistant', 'Other branch') },
						'reply-two': { parent: 'user', message: message('reply-two', 'assistant', 'Selected answer') },
					},
				});
			}
			return new Response('data: {"conversation_id":"chat-one","message":{"id":"reply-three","author":{"role":"assistant"},"content":{"parts":["Next answer"]}}}\n\ndata: [DONE]\n\n', {
				headers: { 'Content-Type': 'text/event-stream' },
			});
		}) as typeof fetch);
		const history = await client.history('chat-one', signal());
		assert.deepEqual(
			history.messages.map(item => item.text),
			['Question', 'Selected answer'],
		);
		const output = await collect(
			client.send(
				{
					text: 'Follow up',
					model: 'fixture-model',
					parentId: history.parentId,
					conversationId: history.id,
					messageId: 'new-user',
				},
				signal(),
			),
		);
		assert.equal(output[0]!.message!.text, 'Next answer');
		const sent = calls.at(-1)!;
		assert.equal(sent.path, '/service/backend-api/f/conversation');
		assert.equal(new Headers(sent.init.headers).get('Authorization'), null);
		assert.equal(new Headers(sent.init.headers).get('X-Ash-ChatGPT-Account'), null);
		assert.ok(calls.every(call => !call.path.endsWith('/me')));
		assert.equal(new Headers(sent.init.headers).get('OpenAI-Sentinel-Chat-Requirements-Token'), 'fixture-requirements');
		assert.equal(new Headers(sent.init.headers).get('OpenAI-Sentinel-Proof-Token'), 'fixture-proof');
		assert.equal(new Headers(sent.init.headers).get('OpenAI-Sentinel-Turnstile-Token'), 'fixture-vm');
		const body = JSON.parse(String(sent.init.body));
		assert.equal(body.parent_message_id, 'reply-two');
		assert.equal(body.conversation_id, 'chat-one');
		assert.equal(body.model, 'fixture-model');
		assert.deepEqual(body.messages[0].content, { content_type: 'text', parts: ['Follow up'] });
	});

	test('separates tool calls and results from answers in history and streamed snapshots', async () => {
		const input = '{"path":"/GitHub/fixture/fetch_file","args":{"path":"README.md"}}';
		const messages = [
			{ id: 'question', author: { role: 'user' }, content: { content_type: 'text', parts: [input] } },
			{
				id: 'call',
				author: { role: 'assistant' },
				recipient: 'functions.execute',
				channel: 'commentary',
				content: { content_type: 'code', text: input },
			},
			{
				id: 'result',
				author: { role: 'tool', name: 'functions.execute' },
				status: 'failed',
				content: { content_type: 'text', parts: ['File unavailable'] },
			},
			{
				id: 'progress',
				author: { role: 'assistant' },
				channel: 'commentary',
				content: { content_type: 'text', parts: ['Checking another source'] },
			},
			{
				id: 'answer',
				author: { role: 'assistant' },
				recipient: 'all',
				channel: 'final',
				content: { content_type: 'code', text: input },
			},
		];
		const client = new ChatGPTClient((async () =>
			json({
				current_node: 'answer',
				mapping: Object.fromEntries(messages.map((message, index) => [message.id, { parent: messages[index - 1]?.id, message }])),
			})) as typeof fetch);
		const history = await client.history('fixture', signal());
		assert.equal(history.parentId, 'answer');
		assert.deepEqual(
			history.messages.map(message => message.activity),
			[
				undefined,
				{ kind: 'call', tool: 'functions.execute', failed: false },
				{ kind: 'result', tool: 'functions.execute', failed: true },
				{ kind: 'progress', tool: undefined, failed: false },
				undefined,
			],
		);
		assert.equal(history.messages[0]!.text, input);
		assert.equal(history.messages[1]!.text, input);
		assert.equal(history.messages[4]!.text, '```\n' + input + '\n```');
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(messages.map(message => `data: ${JSON.stringify({ conversation_id: 'fixture', message })}\n\n`).join('') + 'data: [DONE]\n\n'));
				controller.close();
			},
		});
		const updates = await collect(decodeChatGPTStream(stream, signal()));
		assert.deepEqual(
			updates.map(update => update.message),
			history.messages,
		);
	});

	test('omits empty history messages while retaining content and the actual continuation node', async () => {
		const client = new ChatGPTClient((async () => {
			return json({
				current_node: 'empty-leaf',
				mapping: {
					user: { parent: null, message: message('user', 'user', 'Question') },
					empty: { parent: 'user', message: message('empty', 'assistant', '') },
					recap: {
						parent: 'empty',
						message: {
							id: 'recap',
							author: { role: 'assistant' },
							content: { content_type: 'reasoning_recap', content: 'Thought for a few seconds' },
						},
					},
					whitespace: { parent: 'recap', message: message('whitespace', 'assistant', ' \t\n ') },
					'no-parts': {
						parent: 'whitespace',
						message: { id: 'no-parts', author: { role: 'assistant' }, content: { parts: [] } },
					},
					reply: { parent: 'no-parts', message: message('reply', 'assistant', '  Answer\n') },
					attachment: {
						parent: 'reply',
						message: {
							id: 'attachment',
							author: { role: 'user' },
							content: { parts: [{ content_type: 'image_asset_pointer' }] },
						},
					},
					'empty-leaf': { parent: 'attachment', message: message('empty-leaf', 'assistant', '') },
				},
			});
		}) as typeof fetch);
		const history = await client.history('fixture', signal());
		assert.deepEqual(history.messages, [
			{ id: 'user', role: 'user', text: 'Question' },
			{ id: 'reply', role: 'assistant', text: '  Answer\n' },
			{ id: 'attachment', role: 'user', text: '[View this content in ChatGPT](https://chatgpt.com/c/fixture)' },
		]);
		assert.equal(history.parentId, 'empty-leaf');
	});

	test('retains mixed media, structured text, code payloads and named attachments', async () => {
		const payload = (id: string, content: object, metadata = {}): object => ({
			id,
			author: { role: 'assistant' },
			content,
			metadata,
		});
		const client = new ChatGPTClient((async () =>
			json({
				current_node: 'file',
				mapping: {
					mixed: {
						parent: null,
						message: payload('mixed', {
							content_type: 'multimodal_text',
							parts: ['Before', { content_type: 'image_asset_pointer', alt: 'Diagram' }, 'After', { content_type: 'text', text: '**Structured text**' }],
						}),
					},
					code: {
						parent: 'mixed',
						message: payload('code', { content_type: 'code', text: '<chart/>\n```\nend' }),
					},
					audio: { parent: 'code', message: payload('audio', { content_type: 'audio', text: 'Transcript' }) },
					unknown: { parent: 'audio', message: payload('unknown', { content_type: 'future-rich-content' }) },
					file: {
						parent: 'unknown',
						message: payload('file', { content_type: 'text', parts: ['File caption'] }, { attachments: [{ name: '<report>[1].pdf' }] }),
					},
				},
			})) as typeof fetch);
		const { messages } = await client.history('fixture', signal());
		assert.match(messages[0]!.text, /Before\nDiagram\n\n\[View this content in ChatGPT\]\(https:\/\/chatgpt\.com\/c\/fixture\)\nAfter\n\*\*Structured text\*\*/u);
		assert.equal(messages[1]!.text, '````\n<chart/>\n```\nend\n````');
		assert.equal(messages[2]!.text, 'Transcript\n\n[View this content in ChatGPT](https://chatgpt.com/c/fixture)');
		assert.match(messages[3]!.text, /View this content in ChatGPT/u);
		assert.match(messages[4]!.text, /File caption\n\nAttachment: &lt;report&gt;\\\[1\\\]\.pdf\n\n\[View this content/u);
	});

	test('retains a structured part arriving in a streaming reply', async () => {
		const initial = {
			conversation_id: 'stream-chat',
			message: {
				id: 'reply',
				author: { role: 'assistant' },
				content: {
					content_type: 'multimodal_text',
					parts: ['Caption', { content_type: 'image_asset_pointer' }],
				},
			},
		};
		const body = `data: ${JSON.stringify(initial)}\n\ndata: [DONE]\n\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		});
		const updates = await collect(decodeChatGPTStream(stream, signal()));
		assert.equal(updates[0]!.message!.text, 'Caption\n[View this content in ChatGPT](https://chatgpt.com/c/stream-chat)');
	});

	test('does not turn a web reasoning status into an empty streamed answer', async () => {
		const events =
			[
				{
					conversation_id: 'fixture',
					message: {
						id: 'recap',
						author: { role: 'assistant' },
						content: { content_type: 'reasoning_recap', content: 'Thought for a few seconds' },
					},
				},
				{ conversation_id: 'fixture', message: message('answer', 'assistant', 'Visible answer') },
			]
				.map(value => `data: ${JSON.stringify(value)}\n\n`)
				.join('') + 'data: [DONE]\n\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(events));
				controller.close();
			},
		});
		const updates = await collect(decodeChatGPTStream(stream, signal()));
		assert.equal(updates[0]!.conversationId, 'fixture');
		assert.equal(updates[0]!.message, undefined);
		assert.deepEqual(
			updates.flatMap(update => (update.message ? [update.message.text] : [])),
			['Visible answer'],
		);
	});

	test('never sends after verification is rejected or cancelled', async () => {
		let resolveVerification!: (response: Response) => void;
		let rejectVerification = true;
		let sent = 0;
		const client = new ChatGPTClient((async url => {
			const path = String(url);
			if (path.endsWith('/prepare')) {
				return json({ conduit_token: 'fixture-conduit' });
			}
			if (path.includes('/.headers/')) {
				return rejectVerification
					? new Response(null, { status: 428 })
					: new Promise<Response>(resolve => {
							resolveVerification = resolve;
						});
			}
			sent++;
			return new Response(null, { status: 500 });
		}) as typeof fetch);
		const input = { text: 'Fixture', model: 'fixture', parentId: 'parent', messageId: 'user' };
		await assert.rejects(collect(client.send(input, signal())), /verification could not finish/u);
		rejectVerification = false;
		const controller = new AbortController();
		const pending = collect(client.send(input, controller.signal));
		while (!resolveVerification) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
		controller.abort();
		resolveVerification(json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'unused' }));
		await assert.rejects(pending, { name: 'AbortError' });
		assert.equal(sent, 0);
	});

	test('decodes UTF-8 across chunks and v1 deltas without permitting prototype paths', async () => {
		const initial = { conversation_id: 'fixture', message: message('reply', 'assistant', '你') };
		const events =
			[
				'event: delta_encoding\ndata: "v1"',
				`event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: initial })}`,
				`event: delta\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '好' })}`,
				`event: delta\ndata: ${JSON.stringify({ p: '/__proto__/polluted', o: 'add', v: true })}`,
				'data: [DONE]',
			].join('\r\n\r\n') + '\r\n\r\n';
		const bytes = new TextEncoder().encode(events);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) {
					controller.enqueue(Uint8Array.of(byte));
				}
				controller.close();
			},
		});
		const output = await collect(decodeChatGPTStream(stream, signal()));
		assert.equal(output[0]!.message!.text, '你');
		assert.equal(output[1]!.message!.text, '你好');
		assert.equal(Reflect.get(Object.prototype, 'polluted'), undefined);
	});

	test('decodes CR-only frames in a large HTTP chunk and releases the reader after DONE', async () => {
		const initial = { conversation_id: 'fixture', message: message('reply', 'assistant', '完整') };
		const keepalive = `: ${' '.repeat(64 * 1024)}\r\r`;
		const body = keepalive.repeat(65) + `data: ${JSON.stringify(initial)}\r\rdata: [DONE]\r\rdata: malformed\r\r`;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
			},
			cancel() {
				cancelled = true;
			},
		});
		const output = await collect(decodeChatGPTStream(stream, signal()));
		assert.equal(output[0]!.message!.text, '完整');
		assert.equal(output.length, 1);
		assert.equal(cancelled, true);
		assert.equal(stream.locked, false);
	});

	test('limits unfinished UTF-8 frames including comments, unknown fields and multiple data lines', async () => {
		for (const body of [
			`:${'x'.repeat(4 * 1024 * 1024)}`,
			`unknown: ${'x'.repeat(4 * 1024 * 1024)}`,
			`data: ${'x'.repeat(64 * 1024)}\n`.repeat(65),
			`data: ${'x'.repeat(32760)}\r\n`.repeat(128) + 'x',
			`data: ${'🌲'.repeat(1024 * 1024)}`,
		]) {
			let cancelled = false;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(body));
				},
				cancel() {
					cancelled = true;
				},
			});
			await assert.rejects(collect(decodeChatGPTStream(stream, signal())), /unsupported response/u);
			assert.equal(cancelled, true);
			assert.equal(stream.locked, false);
		}
	});

	test('surfaces a truncated stream and cancels the reader on interruption', async () => {
		const truncated = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
				controller.close();
			},
		});
		await assert.rejects(collect(decodeChatGPTStream(truncated, signal())), /may already have been sent/u);
		let cancelled = false;
		const pending = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const controller = new AbortController();
		const iterator = decodeChatGPTStream(pending, controller.signal);
		const next = iterator.next();
		controller.abort();
		await assert.rejects(next);
		assert.equal(cancelled, true);
	});

	test('does not let stream deltas expand sparse arrays or assign array metadata', async () => {
		const initial = { conversation_id: 'fixture', message: message('reply', 'assistant', 'Safe') };
		const events =
			[
				initial,
				{ p: '/message/content/parts/100000', o: 'add', v: 'Sparse' },
				{ p: '/message/content/parts/length', o: 'replace', v: 200000 },
				{ p: '/message/content/parts/01', o: 'add', v: 'Invalid index' },
				{ p: '/message/content/parts/1', o: 'add', v: 'Next part' },
			]
				.map(value => `data: ${JSON.stringify(value)}\n\n`)
				.join('') + 'data: [DONE]\n\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(events));
				controller.close();
			},
		});
		assert.deepEqual(
			(await collect(decodeChatGPTStream(stream, signal()))).map(update => update.message?.text),
			['Safe', 'Safe', 'Safe', 'Safe', 'Safe\nNext part'],
		);
	});

	test('reports web request failures without replaying or requiring an account handshake', async () => {
		let sends = 0;
		const client = new ChatGPTClient((async url => {
			assert.equal(String(url), '/service/backend-api/f/conversation/prepare');
			sends++;
			return new Response(null, { status: 401 });
		}) as typeof fetch);
		const input = { text: 'Synthetic prompt', model: 'fixture', parentId: 'parent', messageId: 'user' };
		await assert.rejects(collect(client.send(input, signal())), /401/u);
		assert.equal(sends, 1);
		await assert.rejects(collect(client.send(input, signal())), /401/u);
		assert.equal(sends, 2);
	});

	test('cancels a response arriving after its request was aborted', async () => {
		let finish!: (response: Response) => void;
		let cancelled = false;
		const client = new ChatGPTClient(
			(async () =>
				new Promise<Response>(resolve => {
					finish = resolve;
				})) as typeof fetch,
		);
		const controller = new AbortController();
		const pending = client.conversations(0, controller.signal);
		controller.abort();
		finish(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
		);
		await assert.rejects(pending, { name: 'AbortError' });
		assert.equal(cancelled, true);
	});
});
