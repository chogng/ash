use ash_sandboxing::PreparedCommand;
use ash_sandboxing::SandboxCommand;
use serde_json::Value;
use serde_json::json;
use std::ffi::OsString;
use std::io;
use std::io::Read;
use std::io::Write;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::sync::mpsc;

enum Source {
    Protocol,
    Stdout,
    Stderr,
}

enum Event {
    Message(Value),
    End(Source),
    InputClosed,
    Failed(io::Error),
}

enum Phase {
    Connected,
    Draining,
}

// Keep an incomplete code point for the next pipe read. Invalid target bytes
// remain displayable, but splitting UTF-8 between reads must not corrupt text.
fn take_output(buffer: &mut Vec<u8>) -> String {
    let mut offset = 0;
    let end = loop {
        match std::str::from_utf8(&buffer[offset..]) {
            Ok(_) => break buffer.len(),
            Err(error) => match error.error_len() {
                Some(length) => offset += error.valid_up_to() + length,
                None => break offset + error.valid_up_to(),
            },
        }
    };
    let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
    buffer.drain(..end);
    text
}

/// Process entrypoint for CodeLLDB's TCP-to-stdio bridge. The parent Debug runtime
/// owns this process; its backend process handle owns the adapter and debuggee tree.
/// No request pairing, execution state or breakpoint semantics live in this bridge.
pub fn run_adapter(program: OsString, mut arguments: Vec<OsString>) -> io::Result<()> {
    if program.is_empty()
        || arguments.len() > 256
        || arguments.iter().any(|argument| {
            let value = argument.to_string_lossy();
            value.len() > 4096
                || ["--port", "--connect", "--multi-session"]
                    .iter()
                    .any(|flag| value == *flag || value.starts_with(&format!("{flag}=")))
        })
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let listener = runtime.block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))?;
    arguments.extend([
        "--connect".into(),
        listener.local_addr()?.port().to_string().into(),
    ]);
    let command = SandboxCommand::new(program, arguments, std::env::current_dir()?);
    let environment = std::env::vars().collect::<Vec<_>>();
    let mut child = PreparedCommand::unrestricted(&command)
        .spawn(&environment)
        .map_err(io::Error::other)?;
    let (sender, mut receiver) = mpsc::channel(8);
    let mut readers = Vec::new();
    for (source, pipe) in [
        (Source::Stdout, child.take_stdout()),
        (Source::Stderr, child.take_stderr()),
    ] {
        let mut pipe = pipe.ok_or(io::ErrorKind::BrokenPipe)?;
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            let category = match source {
                Source::Stdout => "stdout",
                Source::Stderr => "stderr",
                Source::Protocol => unreachable!(),
            };
            let mut buffer = [0; 8192];
            let mut pending = Vec::new();
            loop {
                let (output, finished) = match pipe.read(&mut buffer) {
                    Ok(0) => (String::from_utf8_lossy(&pending).into_owned(), true),
                    Ok(length) => {
                        pending.extend_from_slice(&buffer[..length]);
                        (take_output(&mut pending), false)
                    }
                    Err(error) => {
                        let _ = sender.blocking_send(Event::Failed(error));
                        return;
                    }
                };
                if !output.is_empty() {
                    // Adapter event sequence numbers are independent of request_seq.
                    // seq=0 is valid DAP; the shared runtime assigns observation order.
                    let message = json!({"seq":0,"type":"event","event":"output","body":{
                        "category":category,"output":output
                    }});
                    if sender.blocking_send(Event::Message(message)).is_err() {
                        return;
                    }
                }
                if finished {
                    break;
                }
            }
            let _ = sender.blocking_send(Event::End(source));
        }));
    }
    let result = runtime.block_on(async {
        let (socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
        drop(listener);
        let (socket, mut writer) = socket.into_split();
        let (input, mut input_bytes) = mpsc::channel::<Vec<u8>>(8);
        let input_events = sender.clone();
        // This executable exits after either transport closes. A blocked stdin
        // reader cannot outlive that process or keep the adapter's job alive.
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match io::stdin().read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        if input.blocking_send(buffer[..length].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = input_events.blocking_send(Event::Failed(error));
                        break;
                    }
                }
            }
        });
        let input_events = sender.clone();
        let input_writer = tokio::spawn(async move {
            while let Some(bytes) = input_bytes.recv().await {
                if let Err(error) = writer.write_all(&bytes).await {
                    let _ = input_events.send(Event::Failed(error)).await;
                    return;
                }
            }
            let _ = writer.shutdown().await;
            let _ = input_events.send(Event::InputClosed).await;
        });
        let mut reader = BufReader::new(socket);
        let protocol_events = sender.clone();
        let protocol = tokio::spawn(async move {
            loop {
                match ash_debug_adapter::read_message(&mut reader).await {
                    Ok(Some(message)) => {
                        if protocol_events.send(Event::Message(message)).await.is_err() {
                            return;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = protocol_events
                            .send(Event::Failed(io::Error::other(error)))
                            .await;
                        return;
                    }
                }
            }
            let _ = protocol_events.send(Event::End(Source::Protocol)).await;
        });
        drop(sender);
        let mut phase = Phase::Connected;
        let mut outputs_closed = 0;
        let mut stdout = io::stdout().lock();
        let result = async {
            while let Some(event) = receiver.recv().await {
                match event {
                    Event::Message(message) => {
                        stdout.write_all(
                            &ash_debug_adapter::encode_message(&message)
                                .map_err(io::Error::other)?,
                        )?;
                        stdout.flush()?;
                    }
                    Event::End(Source::Protocol) => {
                        phase = Phase::Draining;
                        child.close()?;
                    }
                    Event::End(Source::Stdout | Source::Stderr) => outputs_closed += 1,
                    Event::InputClosed => break,
                    Event::Failed(error) => return Err(error),
                }
                if matches!(phase, Phase::Draining) && outputs_closed == 2 {
                    break;
                }
            }
            Ok(())
        }
        .await;
        input_writer.abort();
        let _ = input_writer.await;
        protocol.abort();
        let _ = protocol.await;
        result
    });
    let closed = child.close();
    drop(receiver);
    for reader in readers {
        let _ = reader.join();
    }
    result.and(closed)
}

#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;
