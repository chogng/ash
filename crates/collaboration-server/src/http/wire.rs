use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 12 * 1024 * 1024;

pub(super) struct HttpRequest {
    pub(super) method: String,
    pub(super) target: String,
    headers: BTreeMap<String, String>,
    pub(super) body: Vec<u8>,
}

impl HttpRequest {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub(super) enum HttpReadError {
    Status(u16, &'static str),
    Io(std::io::Error),
}

pub(super) fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, HttpReadError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut buffer).map_err(HttpReadError::Io)?;
        if count == 0 {
            return Err(HttpReadError::Status(400, "Bad Request"));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(HttpReadError::Status(
                431,
                "Request Header Fields Too Large",
            ));
        }
        if let Some(index) = find_header_end(&bytes) {
            break index;
        }
    };
    let head = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| HttpReadError::Status(400, "Bad Request"))?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines
        .next()
        .ok_or(HttpReadError::Status(400, "Bad Request"))?
        .split_whitespace();
    let method = request_line
        .next()
        .ok_or(HttpReadError::Status(400, "Bad Request"))?
        .to_string();
    let target = request_line
        .next()
        .ok_or(HttpReadError::Status(400, "Bad Request"))?
        .to_string();
    if request_line.next() != Some("HTTP/1.1") || request_line.next().is_some() {
        return Err(HttpReadError::Status(400, "Bad Request"));
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpReadError::Status(400, "Bad Request"));
        };
        if headers
            .insert(name.trim().to_ascii_lowercase(), value.trim().to_string())
            .is_some()
        {
            return Err(HttpReadError::Status(400, "Bad Request"));
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err(HttpReadError::Status(400, "Bad Request"));
    }
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| HttpReadError::Status(400, "Bad Request"))?
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err(HttpReadError::Status(413, "Content Too Large"));
    }
    let body_start = header_end + 4;
    while bytes.len().saturating_sub(body_start) < content_length {
        let count = stream.read(&mut buffer).map_err(HttpReadError::Io)?;
        if count == 0 {
            return Err(HttpReadError::Status(400, "Bad Request"));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(HttpRequest {
        method,
        target,
        headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

pub(super) fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

pub(super) fn authorized(request: &HttpRequest, token: &str) -> bool {
    let Some(candidate) = bearer_token(request) else {
        return false;
    };
    constant_time_eq(candidate.as_bytes(), token.as_bytes())
}

pub(super) fn bearer_token(request: &HttpRequest) -> Option<&str> {
    request.header("authorization")?.strip_prefix("Bearer ")
}

pub(super) fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    stream.write_all(body)?;
    stream.flush()
}

pub(super) fn write_empty_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n"
    )?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    stream.flush()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}
