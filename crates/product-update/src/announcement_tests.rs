use super::*;
use std::io::Write;
use std::net::TcpListener;

const RULE: &str = r#"
[[announcements]]
target_app = "ashCode"
version_requirement = "<0.2.0"
from_date = "2026-10-05"
to_date = "2026-11-05"
target_oses = ["macos"]
[announcements.content]
en = "Run ash update to upgrade."
zh-CN = "运行 ash update 升级。"
"#;

#[test]
fn announcement_selection_obeys_client_version_os_and_utc_boundaries() {
    let document = AnnouncementDocument::parse(RULE).unwrap();
    let old = Version::parse("0.1.0").unwrap();
    let new = Version::parse("0.2.0").unwrap();
    let context = AnnouncementContext {
        product: UpdateProduct::AshCode,
        version: &old,
        os: "macos",
        date: NaiveDate::from_ymd_opt(2026, 10, 5).unwrap(),
    };
    let content = document.select(&context).unwrap();
    assert_eq!(content.text("zh-CN"), Some("运行 ash update 升级。"));
    assert_eq!(content.text("ja"), None);
    for excluded in [
        AnnouncementContext {
            version: &new,
            ..context
        },
        AnnouncementContext {
            os: "linux",
            ..context
        },
        AnnouncementContext {
            product: UpdateProduct::ElectronDesktop,
            ..context
        },
        AnnouncementContext {
            date: NaiveDate::from_ymd_opt(2026, 10, 4).unwrap(),
            ..context
        },
        AnnouncementContext {
            date: NaiveDate::from_ymd_opt(2026, 11, 5).unwrap(),
            ..context
        },
    ] {
        assert!(document.select(&excluded).is_none());
    }
}

#[test]
fn announcement_last_matching_entry_wins_and_empty_feed_is_valid() {
    let version = Version::parse("0.1.0").unwrap();
    let context = AnnouncementContext {
        product: UpdateProduct::AshCode,
        version: &version,
        os: "macos",
        date: NaiveDate::from_ymd_opt(2026, 10, 5).unwrap(),
    };
    let feed = format!(
        "{RULE}\n{}",
        RULE.replace("Run ash update to upgrade.", "New announcement.")
    );
    assert_eq!(
        AnnouncementDocument::parse(&feed)
            .unwrap()
            .select(&context)
            .unwrap()
            .text("en"),
        Some("New announcement.")
    );
    assert!(
        AnnouncementDocument::parse("announcements = []")
            .unwrap()
            .select(&context)
            .is_none()
    );
    let prerelease = Version::parse("0.1.1-beta.1").unwrap();
    assert!(
        AnnouncementDocument::parse(RULE)
            .unwrap()
            .select(&AnnouncementContext {
                version: &prerelease,
                ..context
            })
            .is_none()
    );
}

#[test]
fn announcement_rejects_invalid_rules_and_terminal_controls() {
    for invalid in [
        RULE.replace("<0.2.0", "not a version"),
        RULE.replace("2026-10-05", "2026-99-05"),
        RULE.replace("2026-10-05", "2026-1-5"),
        RULE.replace("2026-11-05", "2026-10-05"),
        RULE.replace("macos", "unknown"),
        RULE.replace("ashCode", "unknown"),
        RULE.replace("Run ash update to upgrade.", ""),
        RULE.replace("Run ash update to upgrade.", "\\u001b[31mUnsafe"),
        RULE.replace("Run ash update to upgrade.", &"x".repeat(1025)),
        RULE.replace("version_requirement", "version_regex"),
    ] {
        assert!(
            AnnouncementDocument::parse(&invalid).is_err(),
            "accepted {invalid}"
        );
    }
}

fn serve(body: Vec<u8>, status: u16) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/announcement_tip.toml",
        listener.local_addr().unwrap()
    );
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
        }
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with("GET /announcement_tip.toml "));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("user-agent: ash-announcements")
        );
        write!(
            stream,
            "HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        // Oversized-response validation may close the socket before the final bytes.
        let _ = stream.write_all(&body);
    });
    (endpoint, worker)
}

#[test]
fn announcement_fetch_validates_real_http_responses_and_limits() {
    for (body, status, valid) in [
        (RULE.as_bytes().to_vec(), 200, true),
        (b"announcements = []".to_vec(), 200, true),
        (RULE.as_bytes().to_vec(), 503, false),
        (vec![b'x'; 64 * 1024 + 1], 200, false),
        (vec![0xff], 200, false),
        (b"broken toml".to_vec(), 200, false),
    ] {
        let (endpoint, worker) = serve(body, status);
        assert_eq!(AnnouncementDocument::fetch(&endpoint).is_ok(), valid);
        worker.join().unwrap();
    }
    for endpoint in [
        "http://example.com/feed",
        "https://user:secret@example.com/feed",
        "file:///feed",
        "bad url",
    ] {
        assert!(AnnouncementDocument::fetch(endpoint).is_err());
    }
}
