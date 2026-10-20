#![cfg(any(target_os = "windows", target_os = "linux"))]

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use ash_keyring_store::KeyringSecretStore;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::ProfileSecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;

const MASTER_KEY: &str = "storage/file-encryption-key/v1";
const DIRECT_KEY: &str = "test/system-keyring/binary";
const VALUE_KEY: &str = "test/system-keyring/credential";
const VALUE: &[u8] = b"fixture-only-credential\0\xff";
const REPLACEMENT: &[u8] = b"fixture-only-replacement\xff\0";

fn key(name: &str) -> SecretKey {
    SecretKey::new(name).unwrap()
}

struct Cleanup(KeyringSecretStore);

impl Drop for Cleanup {
    fn drop(&mut self) {
        // This guard outlives every child, and runs before the profile directory is removed,
        // including when a child fails. Never leave this opt-in test's master key behind.
        for name in [MASTER_KEY, DIRECT_KEY] {
            if let Err(error) = self.0.delete(&key(name)) {
                eprintln!("system keyring fixture cleanup failed: {error}");
            }
        }
    }
}

#[test]
#[ignore = "uses the OS credential store; Linux requires an isolated, unlocked test Secret Service"]
fn real_keyring_round_trip_and_process_restart() {
    let profile = tempfile::tempdir().unwrap();
    let cleanup = Cleanup(KeyringSecretStore::for_profile(profile.path()).unwrap());
    let empty = ProfileSecretStore::open(
        profile.path().join("secrets"),
        Arc::new(KeyringSecretStore::for_profile(profile.path()).unwrap()),
    )
    .unwrap();
    assert!(empty.load(&key(VALUE_KEY)).unwrap().is_none());
    assert_eq!(
        empty.delete(&key(VALUE_KEY)).unwrap(),
        DeleteSecretOutcome::NotFound
    );
    assert!(cleanup.0.load(&key(MASTER_KEY)).unwrap().is_none());
    drop(empty);

    let run = |phase| {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "system_keyring_worker",
                "--nocapture",
            ])
            .env("ASH_SYSTEM_KEYRING_TEST_PROFILE", profile.path())
            .env("ASH_SYSTEM_KEYRING_TEST_PHASE", phase)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "keyring worker {phase} failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run("write");
    let master = cleanup.0.load(&key(MASTER_KEY)).unwrap().unwrap();
    assert_eq!(master.expose().len(), 32);
    run("recover");
    run("delete");
    assert_eq!(
        cleanup.0.load(&key(MASTER_KEY)).unwrap().unwrap().expose(),
        master.expose(),
        "restarts and deleting the last credential must retain the same profile key"
    );
    assert!(cleanup.0.load(&key(DIRECT_KEY)).unwrap().is_none());
    cleanup.0.delete(&key(MASTER_KEY)).unwrap();
    assert!(cleanup.0.load(&key(MASTER_KEY)).unwrap().is_none());
}

#[test]
#[ignore = "child process for real_keyring_round_trip_and_process_restart"]
fn system_keyring_worker() {
    let Some(profile) = std::env::var_os("ASH_SYSTEM_KEYRING_TEST_PROFILE") else {
        return;
    };
    let profile = Path::new(&profile);
    let keyring = Arc::new(KeyringSecretStore::for_profile(profile).unwrap());
    let store = ProfileSecretStore::open(profile.join("secrets"), keyring.clone()).unwrap();
    match std::env::var("ASH_SYSTEM_KEYRING_TEST_PHASE")
        .unwrap()
        .as_str()
    {
        "write" => {
            keyring
                .store(&key(DIRECT_KEY), &SecretValue::new(VALUE.to_vec()))
                .unwrap();
            assert_eq!(
                keyring.load(&key(DIRECT_KEY)).unwrap().unwrap().expose(),
                VALUE
            );
            keyring
                .store(&key(DIRECT_KEY), &SecretValue::new(REPLACEMENT.to_vec()))
                .unwrap();
            store
                .store(&key(VALUE_KEY), &SecretValue::new(VALUE.to_vec()))
                .unwrap();
            assert_eq!(
                store.load(&key(VALUE_KEY)).unwrap().unwrap().expose(),
                VALUE
            );
        }
        "recover" => {
            assert_eq!(
                keyring.load(&key(DIRECT_KEY)).unwrap().unwrap().expose(),
                REPLACEMENT
            );
            assert_eq!(
                keyring.delete(&key(DIRECT_KEY)).unwrap(),
                DeleteSecretOutcome::Deleted
            );
            assert_eq!(
                keyring.delete(&key(DIRECT_KEY)).unwrap(),
                DeleteSecretOutcome::NotFound
            );
            assert_eq!(
                store.load(&key(VALUE_KEY)).unwrap().unwrap().expose(),
                VALUE
            );
            store
                .store(&key(VALUE_KEY), &SecretValue::new(REPLACEMENT.to_vec()))
                .unwrap();
        }
        "delete" => {
            assert_eq!(
                store.load(&key(VALUE_KEY)).unwrap().unwrap().expose(),
                REPLACEMENT
            );
            assert_eq!(
                store.delete(&key(VALUE_KEY)).unwrap(),
                DeleteSecretOutcome::Deleted
            );
            assert_eq!(
                store.delete(&key(VALUE_KEY)).unwrap(),
                DeleteSecretOutcome::NotFound
            );
            assert!(store.load(&key(VALUE_KEY)).unwrap().is_none());
        }
        phase => panic!("unknown system keyring test phase: {phase}"),
    }
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires secret-tool and an isolated, unlocked test Secret Service"]
fn existing_secret_service_attributes_remain_readable() {
    use std::io::Write;
    use std::process::Stdio;

    use ash_keyring_store::delete_credential;
    use ash_keyring_store::read_credential;
    use ash_keyring_store::write_credential;

    struct EntryCleanup(String);
    impl Drop for EntryCleanup {
        fn drop(&mut self) {
            delete_credential(&self.0, "fixture-account").unwrap();
        }
    }

    // Both backends use keyring's same service/username/target identity. Seed items
    // independently, including the older default-collection form without target,
    // to catch accidental namespace changes or replacement with a fresh credential.
    for with_target in [true, false] {
        let service = format!(
            "com.ash.migration-fixture.{}.{with_target}",
            std::process::id()
        );
        let _cleanup = EntryCleanup(service.clone());
        let mut command = Command::new("secret-tool");
        command.args([
            "store",
            "--label",
            "Ash migration fixture",
            "service",
            &service,
            "username",
            "fixture-account",
            "application",
            "rust-keyring-client",
        ]);
        if with_target {
            command.args(["target", "default"]);
        }
        let mut seed = command.stdin(Stdio::piped()).spawn().unwrap();
        seed.stdin
            .take()
            .unwrap()
            .write_all(b"existing-fixture-secret")
            .unwrap();
        assert!(seed.wait().unwrap().success());
        assert_eq!(
            read_credential(&service, "fixture-account")
                .unwrap()
                .unwrap()
                .expose(),
            b"existing-fixture-secret"
        );
        write_credential(
            &service,
            "fixture-account",
            &SecretValue::new(b"updated-fixture-secret".to_vec()),
        )
        .unwrap();
        let lookup = Command::new("secret-tool")
            .args(["lookup", "service", &service, "username", "fixture-account"])
            .output()
            .unwrap();
        assert!(lookup.status.success());
        assert_eq!(lookup.stdout, b"updated-fixture-secret");
        assert_eq!(
            delete_credential(&service, "fixture-account").unwrap(),
            DeleteSecretOutcome::Deleted
        );
        assert!(
            read_credential(&service, "fixture-account")
                .unwrap()
                .is_none()
        );
    }
}
