use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;

fn main() {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout().lock();
    loop {
        let Some(message) = read_message(&mut reader) else {
            return;
        };
        let Some(id) = request_id(&message) else {
            if message.contains("\"method\":\"exit\"") {
                return;
            }
            if message.contains("\"method\":\"textDocument/didOpen\"")
                || message.contains("\"method\":\"textDocument/didChange\"")
            {
                publish_diagnostics(&mut stdout, &message);
            }
            continue;
        };
        let result = if message.contains("\"method\":\"initialize\"") {
            r#"{"capabilities":{"positionEncoding":"utf-16","textDocumentSync":{"openClose":true,"change":1},"hoverProvider":true,"completionProvider":{"triggerCharacters":["."]},"documentFormattingProvider":true,"documentRangeFormattingProvider":true,"signatureHelpProvider":{"triggerCharacters":["(",","],"retriggerCharacters":[","]},"inlayHintProvider":true,"linkedEditingRangeProvider":true}}"#
        } else if message.contains("\"method\":\"textDocument/completion\"") {
            r#"{"isIncomplete":false,"items":[{"label":"len","kind":2,"detail":"LSP fixture method","documentation":"Returns the string length","insertText":"len()","insertTextFormat":1}]}"#
        } else if message.contains("\"method\":\"textDocument/hover\"") {
            r#"{"contents":"LSP fixture hover"}"#
        } else if message.contains("\"method\":\"textDocument/formatting\"") {
            r#"[{"range":{"start":{"line":1,"character":0},"end":{"line":1,"character":4}},"newText":"  "}]"#
        } else if message.contains("\"method\":\"textDocument/rangeFormatting\"") {
            r#"[{"range":{"start":{"line":1,"character":0},"end":{"line":1,"character":4}},"newText":"\t"}]"#
        } else if message.contains("\"method\":\"textDocument/signatureHelp\"") {
            r#"{"signatures":[{"label":"String::from(value: &str)","documentation":"Creates a string","parameters":[{"label":"value: &str","documentation":"Source text"}],"activeParameter":0}],"activeSignature":0,"activeParameter":0}"#
        } else if message.contains("\"method\":\"textDocument/inlayHint\"") {
            r#"[{"position":{"line":1,"character":15},"label":": String","kind":1,"tooltip":"inferred type","paddingLeft":true,"paddingRight":false}]"#
        } else if message.contains("\"method\":\"textDocument/linkedEditingRange\"") {
            r#"{"ranges":[{"start":{"line":1,"character":8},"end":{"line":1,"character":15}},{"start":{"line":2,"character":4},"end":{"line":2,"character":11}}],"wordPattern":"[A-Za-z_][A-Za-z0-9_]*"}"#
        } else {
            "null"
        };
        let response = format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#);
        write_message(&mut stdout, &response);
    }
}

fn publish_diagnostics(writer: &mut impl Write, message: &str) {
    let Some(uri) = string_field(message, "uri") else {
        return;
    };
    let version = number_field(message, "version").unwrap_or("1");
    let notification = format!(
        r#"{{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{{"uri":"{uri}","version":{version},"diagnostics":[{{"range":{{"start":{{"line":2,"character":4}},"end":{{"line":2,"character":11}}}},"severity":1,"code":"fixture","source":"ash-smoke-lsp","message":"fixture diagnostic v{version}"}}]}}}}"#,
    );
    write_message(writer, &notification);
}

fn string_field<'a>(message: &'a str, field: &str) -> Option<&'a str> {
    let marker = format!(r#""{field}":""#);
    let value = message.split_once(&marker)?.1;
    Some(value.split_once('"')?.0)
}

fn number_field<'a>(message: &'a str, field: &str) -> Option<&'a str> {
    let marker = format!(r#""{field}":"#);
    let value = message.split_once(&marker)?.1;
    let length = value.bytes().take_while(u8::is_ascii_digit).count();
    (length > 0).then_some(&value[..length])
}

fn read_message(reader: &mut impl BufRead) -> Option<String> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let mut payload = vec![0; content_length?];
    reader.read_exact(&mut payload).ok()?;
    String::from_utf8(payload).ok()
}

fn request_id(message: &str) -> Option<&str> {
    let suffix = message.split_once("\"id\":")?.1;
    let end = suffix.find([',', '}']).unwrap_or(suffix.len());
    Some(&suffix[..end])
}

fn write_message(writer: &mut impl Write, message: &str) {
    write!(writer, "Content-Length: {}\r\n\r\n{message}", message.len())
        .expect("write LSP response");
    writer.flush().expect("flush LSP response");
}
