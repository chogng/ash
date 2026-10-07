use std::io::BufRead;
use std::io::Write;

// A std-only Host RPC fixture needs no workspace, account, network or child-process access.
// It consumes the product host's compact JSON framing and only emits fixed Output operations.
fn main() -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let message = line?;
        let request = number_field(&message, "requestId").expect("host request ID");
        let incarnation = number_field(&message, "incarnation").expect("host incarnation");
        let generation =
            number_field(&message, "activationGeneration").expect("activation generation");
        let context = format!(
            r#""protocolVersion":1,"incarnation":{incarnation},"activationGeneration":{generation}"#
        );
        let method = string_field(&message, "method").expect("host method");
        let result = match method {
            "initialize" => {
                r#""result":"initialized","body":{"protocolVersion":1,"runtimeApiVersion":1}"#
            }
            "activate" => {
                event(
                    &mut stdout,
                    &context,
                    r#""operation":"create","channelId":"plain","label":"Output Filter Fixture","kind":"output""#,
                )?;
                event(
                    &mut stdout,
                    &context,
                    r#""operation":"create","channelId":"log","label":"Output Log Fixture","kind":"log""#,
                )?;
                event(
                    &mut stdout,
                    &context,
                    r#""operation":"create","channelId":"other","label":"Output Other Fixture","kind":"output""#,
                )?;
                append(
                    &mut stdout,
                    &context,
                    "plain",
                    r#"keep one\ndrop one\nkeep excluded\n"#,
                )?;
                append(&mut stdout, &context, "plain", "kee")?;
                append(
                    &mut stdout,
                    &context,
                    "log",
                    r#"keep log\nlog continuation\n"#,
                )?;
                append(&mut stdout, &context, "log", r#"other log\n"#)?;
                append(
                    &mut stdout,
                    &context,
                    "other",
                    r#"drop other\nkeep other\n"#,
                )?;
                r#""result":"activated","body":{"registrations":[{"registrationId":"append","kind":"command","command":"ash.output.fixture.append","title":"Append Output Filter Fixture"},{"registrationId":"finish","kind":"command","command":"ash.output.fixture.finish","title":"Finish Output Filter Fixture"},{"registrationId":"clear","kind":"command","command":"ash.output.fixture.clear","title":"Clear Output Filter Fixture"},{"registrationId":"dispose","kind":"command","command":"ash.output.fixture.dispose","title":"Dispose Output Filter Fixture"}]}"#
            }
            "invoke" => {
                match string_field(&message, "registrationId").expect("command registration") {
                    "append" => {
                        append(&mut stdout, &context, "plain", r#"p tail\r"#)?;
                        append(&mut stdout, &context, "plain", r#"\ndrop two\r"#)?;
                        append(&mut stdout, &context, "plain", r#"\nkee"#)?;
                    }
                    "finish" => append(&mut stdout, &context, "plain", "p unfinished")?,
                    "clear" => event(
                        &mut stdout,
                        &context,
                        r#""operation":"clear","channelId":"plain""#,
                    )?,
                    "dispose" => event(
                        &mut stdout,
                        &context,
                        r#""operation":"dispose","channelId":"plain""#,
                    )?,
                    registration => panic!("unexpected registration {registration}"),
                }
                r#""result":"invoked","body":{"payload":null}"#
            }
            "ping" => r#""result":"pong""#,
            "cancel" => r#""result":"cancelled""#,
            "deactivate" => r#""result":"deactivated""#,
            "shutdown" => r#""result":"shutdown""#,
            method => panic!("unexpected method {method}"),
        };
        writeln!(
            stdout,
            r#"{{{context},"requestId":{request},"status":"success","body":{{{result}}}}}"#
        )?;
        stdout.flush()?;
        if method == "shutdown" {
            return Ok(());
        }
    }
    Ok(())
}

fn event(writer: &mut impl Write, context: &str, operation: &str) -> std::io::Result<()> {
    writeln!(writer, "{{{context},{operation}}}")
}

fn append(
    writer: &mut impl Write,
    context: &str,
    channel: &str,
    escaped_text: &str,
) -> std::io::Result<()> {
    event(
        writer,
        context,
        &format!(
            r#""operation":"append","channelId":"{channel}","text":"{escaped_text}","severity":"log","category":null"#
        ),
    )
}

fn string_field<'a>(message: &'a str, field: &str) -> Option<&'a str> {
    let marker = format!(r#""{field}":""#);
    Some(message.split_once(&marker)?.1.split_once('"')?.0)
}

fn number_field(message: &str, field: &str) -> Option<u64> {
    let marker = format!(r#""{field}":"#);
    let value = message.split_once(&marker)?.1;
    let length = value.bytes().take_while(u8::is_ascii_digit).count();
    value[..length].parse().ok()
}
