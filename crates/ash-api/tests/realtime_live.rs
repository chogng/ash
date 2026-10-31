use ash_api::ApiError;
use ash_api::RealtimeCommand;
use ash_api::RealtimeConfig;
use ash_api::RealtimeEvent;
use ash_api::RealtimeOutput;
use ash_api::RealtimeResponseStatus;
use ash_api::RealtimeSession;
use ash_api::WebSocketSessionConfig;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::RequestBinding;
use ash_client::RequestIdentity;
use ash_client::RequestPurpose;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::OutboundNetworkSnapshot;
use ash_websocket_client::WebSocketConnector;
use futures::FutureExt;
use serde_json::json;
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use std::time::Instant;

// No model/endpoint override or retry: keep the reviewed price and credential destination fixed.
const MODEL: &str = "gpt-realtime-mini-2025-12-15";
const OUTPUT_LIMIT: u32 = 64;
const INPUT_RESERVE: u64 = 3000;
const BUDGET_USD: f64 = 0.10;
// 2026-10-30 public audio prices. Treat even text/cached tokens as uncached audio to overestimate.
const INPUT_USD_PER_TOKEN: f64 = 10.0 / 1_000_000.0;
const OUTPUT_USD_PER_TOKEN: f64 = 20.0 / 1_000_000.0;

#[tokio::test]
#[ignore = "Paid public Realtime GA; requires linked-organization OPENAI_API_KEY and OPENAI_ORG_ID"]
async fn live_realtime_ga_text_audio_cancel() {
    let key = std::env::var("OPENAI_API_KEY")
        .expect("set a project OPENAI_API_KEY from the organization holding the credits");
    assert!(!key.trim().is_empty(), "OPENAI_API_KEY must not be empty");
    let organization = std::env::var("OPENAI_ORG_ID")
        .expect("set OPENAI_ORG_ID to the organization holding the credits");
    assert!(
        !organization.trim().is_empty(),
        "OPENAI_ORG_ID must not be empty"
    );
    let mut headers = vec![
        HttpHeader::new("Authorization", format!("Bearer {key}")),
        HttpHeader::new("OpenAI-Organization", organization),
    ];
    if let Ok(project) = std::env::var("OPENAI_PROJECT_ID") {
        assert!(
            !project.trim().is_empty(),
            "OPENAI_PROJECT_ID must not be empty"
        );
        headers.push(HttpHeader::new("OpenAI-Project", project));
    }
    let target = ResolvedApiTarget::new(
        "https://api.openai.com/v1",
        headers,
        RequestBinding::new(RequestPurpose::Model, RequestIdentity::Anonymous),
    );
    let connector =
        WebSocketConnector::new(OutboundNetworkSnapshot::new(HttpClientConfig::new()).unwrap());
    let token = CancellationSource::new().token();
    let started = Instant::now();
    let mut session = RealtimeSession::connect(
        &connector,
        &target,
        MODEL,
        WebSocketSessionConfig {
            idle_timeout: Duration::from_secs(10),
            max_event_bytes: 256 * 1024,
        },
        &token,
    )
    .await
    .expect("public Realtime authentication/session creation failed; no retry");
    eprintln!(
        "REALTIME_GA {}",
        json!({"model":MODEL,"session_id":session.session_id(),"connect_and_session_ms":started.elapsed().as_millis(),"budget_usd":BUDGET_USD})
    );
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        AssertUnwindSafe(exercise(&mut session, &token)).catch_unwind(),
    )
    .await;
    // Close even after an assertion failure or timeout; never replay a paid response.
    let cleanup = session.close(&CancellationSource::new().token()).await;
    session.abort();
    assert!(!session.is_open());
    eprintln!(
        "REALTIME_GA {}",
        json!({"closed":true,"close_succeeded":cleanup.is_ok(),"total_ms":started.elapsed().as_millis()})
    );
    match result.expect("Realtime test exceeded its total deadline") {
        Ok(result) => result.unwrap(),
        Err(panic) => std::panic::resume_unwind(panic),
    }
    cleanup.unwrap();
}

async fn exercise(
    session: &mut RealtimeSession,
    token: &CancellationToken,
) -> Result<(), ApiError> {
    let mut cost_upper_usd = 0.0;
    configure(session, RealtimeOutput::Text, token).await?;
    session
        .send(
            RealtimeCommand::UserText {
                text: "Say Ready.".into(),
            },
            token,
        )
        .await?;
    response(session, Phase::Text, &mut cost_upper_usd, token).await?;

    configure(
        session,
        RealtimeOutput::Audio {
            voice: "marin".into(),
        },
        token,
    )
    .await?;
    session
        .send(
            RealtimeCommand::UserText {
                text: "Say Ready.".into(),
            },
            token,
        )
        .await?;
    let pcm16 = response(session, Phase::Audio, &mut cost_upper_usd, token).await?;
    // Loop back model audio to exercise real PCM input without opening microphone/playback devices.
    assert!(
        (4800..=96_000).contains(&pcm16.len()),
        "expected 0.1–2 seconds of PCM16/24 kHz"
    );
    for chunk in pcm16.chunks(4800) {
        session
            .send(
                RealtimeCommand::AppendAudio {
                    pcm16: chunk.to_vec(),
                },
                token,
            )
            .await?;
    }
    session.send(RealtimeCommand::CommitAudio, token).await?;
    loop {
        match session.receive(token).await? {
            RealtimeEvent::Other { event_type } if event_type == "input_audio_buffer.committed" => {
                break;
            }
            RealtimeEvent::Error { kind, code, .. } => return Err(provider_error(kind, code)),
            _ => {}
        }
    }
    response(session, Phase::Cancel, &mut cost_upper_usd, token).await?;
    eprintln!(
        "REALTIME_GA {}",
        json!({"cost_upper_usd":cost_upper_usd,"billing_cost_usd":null,"responses":3})
    );
    Ok(())
}

async fn configure(
    session: &mut RealtimeSession,
    output: RealtimeOutput,
    token: &CancellationToken,
) -> Result<(), ApiError> {
    session
        .send(
            RealtimeCommand::Configure(RealtimeConfig {
                instructions: "Synthetic protocol test. Reply with only the word Ready. No tools."
                    .into(),
                output,
                max_output_tokens: Some(OUTPUT_LIMIT),
                ..Default::default()
            }),
            token,
        )
        .await?;
    loop {
        match session.receive(token).await? {
            RealtimeEvent::SessionUpdated => return Ok(()),
            RealtimeEvent::Error { kind, code, .. } => return Err(provider_error(kind, code)),
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Text,
    Audio,
    Cancel,
}

async fn response(
    session: &mut RealtimeSession,
    phase: Phase,
    cost_upper_usd: &mut f64,
    token: &CancellationToken,
) -> Result<Vec<u8>, ApiError> {
    // Fixed short inputs, no tools/VAD/autonomous turns. Reserve a whole response before sending it.
    let reserve =
        INPUT_RESERVE as f64 * INPUT_USD_PER_TOKEN + f64::from(OUTPUT_LIMIT) * OUTPUT_USD_PER_TOKEN;
    assert!(
        *cost_upper_usd + reserve <= BUDGET_USD,
        "test budget exhausted"
    );
    let started = Instant::now();
    let mut first_delta_ms = None;
    let mut cancel_started = None;
    let mut text_bytes = 0;
    let mut transcript_bytes = 0;
    let mut pcm16 = Vec::new();
    session.send(RealtimeCommand::CreateResponse, token).await?;
    loop {
        match session.receive(token).await? {
            RealtimeEvent::ResponseCreated { .. } if phase == Phase::Cancel => {
                cancel_started = Some(Instant::now());
                session.send(RealtimeCommand::CancelResponse, token).await?;
            }
            RealtimeEvent::TextDelta { text, .. } => {
                first_delta_ms.get_or_insert_with(|| started.elapsed().as_millis());
                text_bytes += text.len();
            }
            RealtimeEvent::AudioDelta { pcm16: chunk, .. } => {
                first_delta_ms.get_or_insert_with(|| started.elapsed().as_millis());
                pcm16.extend_from_slice(&chunk);
                assert!(
                    pcm16.len() <= 96_000,
                    "audio exceeded the two-second test bound"
                );
            }
            RealtimeEvent::OutputTranscriptDelta { text, .. } => transcript_bytes += text.len(),
            RealtimeEvent::ResponseDone {
                response_id,
                status,
                usage,
            } => {
                let usage = usage.expect("terminal response must report actual token usage");
                let input = usage.input_tokens.expect("input token usage missing");
                let output = usage.output_tokens.expect("output token usage missing");
                *cost_upper_usd +=
                    input as f64 * INPUT_USD_PER_TOKEN + output as f64 * OUTPUT_USD_PER_TOKEN;
                eprintln!(
                    "REALTIME_GA {}",
                    json!({"phase":format!("{phase:?}"),"response_id":response_id,"status":format!("{status:?}"),"first_delta_ms":first_delta_ms,"response_ms":started.elapsed().as_millis(),"cancel_to_done_ms":cancel_started.map(|time| time.elapsed().as_millis()),"text_bytes":text_bytes,"transcript_bytes":transcript_bytes,"pcm16_bytes":pcm16.len(),"input_tokens":input,"output_tokens":output,"cached_input_tokens":usage.cached_input_tokens,"cost_upper_usd":cost_upper_usd})
                );
                assert!(
                    input <= INPUT_RESERVE && output <= u64::from(OUTPUT_LIMIT),
                    "usage exceeded the reserved token bounds"
                );
                assert!(*cost_upper_usd <= BUDGET_USD);
                match phase {
                    Phase::Text => {
                        assert_eq!(status, RealtimeResponseStatus::Completed);
                        assert!(text_bytes > 0, "text delta missing");
                    }
                    Phase::Audio => {
                        assert_eq!(status, RealtimeResponseStatus::Completed);
                        assert!(
                            !pcm16.is_empty() && transcript_bytes > 0,
                            "audio/transcript delta missing"
                        );
                    }
                    Phase::Cancel => {
                        assert!(cancel_started.is_some());
                        assert_eq!(
                            status,
                            RealtimeResponseStatus::Cancelled,
                            "response finished before cancellation was confirmed; do not automatically retry"
                        );
                    }
                }
                return Ok(pcm16);
            }
            RealtimeEvent::Error { kind, code, .. } => return Err(provider_error(kind, code)),
            _ => {}
        }
    }
}

fn provider_error(kind: String, code: Option<String>) -> ApiError {
    ApiError::InvalidResponse(format!("Realtime provider error: {kind}, code={code:?}"))
}
