use super::system_certificate_verifier;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::ServerName;
use rustls::pki_types::UnixTime;

#[test]
fn system_trust_accepts_an_additional_ca_and_checks_the_peer_name() {
    let verifier = system_certificate_verifier(vec![CertificateDer::from(
        include_bytes!("../tests/fixtures/system-trust-ca.der").to_vec(),
    )])
    .unwrap();
    let leaf =
        CertificateDer::from(include_bytes!("../tests/fixtures/system-trust-server.der").to_vec());
    // Platform trust enforces certificate lifetime limits. Use a one-year leaf
    // and a fixed date within its validity so this regression does not expire.
    let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_790_899_200));
    let valid = verifier.verify_server_cert(
        &leaf,
        &[],
        &ServerName::try_from("localhost").unwrap(),
        &[],
        now,
    );
    assert!(valid.is_ok(), "{valid:?}");
    let invalid = verifier.verify_server_cert(
        &leaf,
        &[],
        &ServerName::try_from("wrong.example.test").unwrap(),
        &[],
        now,
    );
    assert!(
        matches!(
            invalid,
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidForName
                    | rustls::CertificateError::NotValidForNameContext { .. }
            ))
        ),
        "{invalid:?}"
    );
}
