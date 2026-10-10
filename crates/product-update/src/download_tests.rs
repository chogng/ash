use super::*;
use std::net::TcpListener;

fn serve_package(
    body: &'static [u8],
    status: u16,
    redirect: bool,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/package", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        for hop in 0..=usize::from(redirect) {
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
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.contains("user-agent: ash-product-update"));
            assert!(request.contains("accept: application/octet-stream"));
            if redirect && hop == 0 {
                write!(stream, "HTTP/1.1 302 Found\r\nLocation: /artifact\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            } else {
                write!(
                    stream,
                    "HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                let _ = stream.write_all(body);
            }
        }
    });
    (url, worker)
}

#[test]
fn package_http_download_preserves_redirects_and_verifies_before_publishing() {
    let bytes = b"verified desktop package";
    for (body, status, redirect, valid) in [
        (&bytes[..], 200, false, true),
        (&bytes[..], 200, true, true),
        (&bytes[..], 503, false, false),
        (&b"altered desktop package"[..], 200, false, false),
        (&b"verified desktop packagE"[..], 200, false, false),
        (
            &b"verified desktop package plus extra"[..],
            200,
            false,
            false,
        ),
    ] {
        let staging = tempfile::tempdir().unwrap();
        let (url, worker) = serve_package(body, status, redirect);
        let package = VerifiedPackage {
            url,
            file_name: "AshSetup.exe".into(),
            format: PackageFormat::WindowsExe,
            size: bytes.len() as u64,
            sha256: Sha256::digest(bytes).into(),
        };
        let result = stage_verified_package(&package, staging.path());
        assert_eq!(result.is_ok(), valid, "{result:?}");
        assert_eq!(staging.path().join(&package.file_name).exists(), valid);
        assert!(!staging.path().join(".AshSetup.exe.part").exists());
        if let Ok(path) = result {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        worker.join().unwrap();
    }
}
