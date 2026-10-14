use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use aes::Aes256;
use aes_gcm::AesGcm;
use aes_gcm::KeyInit;
use aes_gcm::Nonce;
use aes_gcm::aead::Aead;
use aes_gcm::aead::Payload;
use aes_gcm::aead::consts::U12;
use ash_utils_path::CanonicalPathRoot;
use ash_utils_path::NoSymlinkPathStatus;
use fs2::FileExt;
use zeroize::Zeroizing;

use super::FileSecretStore;
use super::MAX_SECRET_BYTES;
use super::backend_failure;
use super::ensure_directory_without_symlinks;
use super::inspect_path;
use super::lock_error;
use super::require_existing_path;
use super::set_private_directory_permissions;
use super::store_io;
use crate::DeleteSecretOutcome;
use crate::SecretKey;
use crate::SecretStorageMode;
use crate::SecretStore;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;

type Cipher = AesGcm<Aes256, U12>;
const HEADER: &[u8] = b"ASHSEC\0\x01";
const NONCE_BYTES: usize = 12;
const ENVELOPE_BYTES: usize = HEADER.len() + NONCE_BYTES + 16;
const KEY_CHECK: &str = "key-check";
const KEY_CHECK_VALUE: &[u8] = b"ash-profile-secret-key-v1";
const MASTER_KEY_NAME: &str = "storage/file-encryption-key/v1";
const STORAGE_MODE: &str = "storage-mode";

enum StorageState {
    Ready(SecretStorageMode),
    Migrating(SecretStorageMode),
}

/// Profile persistence with encrypted files by default and an explicit private-file alternative.
///
/// The host injects its profile-scoped keyring adapter; this crate never chooses or falls back to
/// another key facility. Operations reread the keyring, so revocation is not bypassed by a cached
/// key. A process-shared file lock serializes key creation, migration and writes across hosts.
pub struct ProfileSecretStore {
    root: PathBuf,
    boundary: CanonicalPathRoot,
    files: FileSecretStore,
    legacy: FileSecretStore,
    keyring: Arc<dyn SecretStore>,
    operations: Mutex<()>,
}

impl ProfileSecretStore {
    /// Opens private directories without accessing the keyring or displaying system prompts.
    ///
    /// The first availability check or secret operation initializes encryption and migrates old
    /// files. Keeping keyring access lazy lets the application show a recoverable storage error.
    pub fn open(
        root: impl AsRef<Path>,
        keyring: Arc<dyn SecretStore>,
    ) -> Result<Self, SecretStoreError> {
        let root = std::path::absolute(root.as_ref()).map_err(store_io)?;
        fs::create_dir_all(&root).map_err(store_io)?;
        let boundary = CanonicalPathRoot::new(&root).map_err(store_io)?;
        require_existing_path(&boundary, &root)?;
        set_private_directory_permissions(&root)?;
        let _lock = acquire_file_lock(&root, &boundary)?;
        let legacy = FileSecretStore::open(&root)?;
        ensure_directory_without_symlinks(&boundary, &root.join("encrypted"))?;
        let files = FileSecretStore::open(root.join("encrypted"))?;
        Ok(Self {
            root,
            boundary,
            files,
            legacy,
            keyring,
            operations: Mutex::new(()),
        })
    }

    fn encryption_key(&self) -> Result<SecretValue, SecretStoreError> {
        let key_name = SecretKey::new(MASTER_KEY_NAME).expect("fixed internal secret key");
        let check_path = self.files.values.join(KEY_CHECK);
        let existing_check = self.files.load_path(&check_path, MAX_SECRET_BYTES)?;
        let key = match self.keyring.load(&key_name)? {
            Some(key) => key,
            None => {
                // A missing key must never replace the key of existing ciphertext, even when the
                // integrity witness was removed or damaged. Recovery requires the original key.
                if existing_check.is_some()
                    || fs::read_dir(&self.files.values)
                        .map_err(store_io)?
                        .next()
                        .transpose()
                        .map_err(store_io)?
                        .is_some()
                {
                    return Err(SecretStoreError::new(
                        SecretStoreErrorKind::KeyMissing,
                        "encrypted secret storage key is missing",
                    ));
                }
                let mut bytes = Zeroizing::new(vec![0; 32]);
                getrandom::getrandom(&mut bytes)
                    .map_err(|_| backend_failure("secret storage key generation failed"))?;
                let key = SecretValue::new(std::mem::take(&mut *bytes));
                self.keyring.store(&key_name, &key)?;
                key
            }
        };
        let cipher = cipher(&key)?;
        match existing_check {
            Some(check) => {
                if decrypt(&cipher, KEY_CHECK, check.expose())?.expose() != KEY_CHECK_VALUE {
                    return Err(invalid_data());
                }
            }
            None => {
                if fs::read_dir(&self.files.values)
                    .map_err(store_io)?
                    .next()
                    .transpose()
                    .map_err(store_io)?
                    .is_some()
                {
                    return Err(invalid_data());
                }
                let check = encrypt(&cipher, KEY_CHECK, KEY_CHECK_VALUE)?;
                self.files.store_path(&check_path, &check)?;
            }
        }
        Ok(key)
    }

    fn prepare(&self) -> Result<SecretValue, SecretStoreError> {
        let key = self.encryption_key()?;
        self.migrate(&cipher(&key)?)
            .map_err(|error| match error.kind() {
                SecretStoreErrorKind::BackendFailure => migration_failed(),
                SecretStoreErrorKind::BackendUnavailable
                | SecretStoreErrorKind::AccessDenied
                | SecretStoreErrorKind::KeyMissing
                | SecretStoreErrorKind::InvalidData
                | SecretStoreErrorKind::MigrationFailed => error,
            })?;
        Ok(key)
    }

    fn storage_state(&self) -> Result<StorageState, SecretStoreError> {
        let value = self.legacy.load_path(&self.root.join(STORAGE_MODE), 32)?;
        match value.as_ref().map(SecretValue::expose) {
            None | Some(b"encrypted") => Ok(StorageState::Ready(SecretStorageMode::Encrypted)),
            Some(b"file") => Ok(StorageState::Ready(SecretStorageMode::File)),
            Some(b"to-encrypted") => Ok(StorageState::Migrating(SecretStorageMode::Encrypted)),
            Some(b"to-file") => Ok(StorageState::Migrating(SecretStorageMode::File)),
            Some(_) => Err(invalid_data()),
        }
    }

    fn write_storage_state(&self, state: StorageState) -> Result<(), SecretStoreError> {
        let value: &[u8] = match state {
            StorageState::Ready(SecretStorageMode::Encrypted) => b"encrypted",
            StorageState::Ready(SecretStorageMode::File) => b"file",
            StorageState::Migrating(SecretStorageMode::Encrypted) => b"to-encrypted",
            StorageState::Migrating(SecretStorageMode::File) => b"to-file",
        };
        self.legacy.store_path(
            &self.root.join(STORAGE_MODE),
            &SecretValue::new(value.to_vec()),
        )
    }

    fn current_mode(&self) -> Result<SecretStorageMode, SecretStoreError> {
        match self.storage_state()? {
            StorageState::Ready(mode) => {
                if mode == SecretStorageMode::File {
                    for entry in fs::read_dir(&self.files.values).map_err(store_io)? {
                        if entry.map_err(store_io)?.file_name() != KEY_CHECK {
                            return Err(migration_failed());
                        }
                    }
                    self.files.delete_path(&self.files.values.join(KEY_CHECK))?;
                }
                Ok(mode)
            }
            StorageState::Migrating(mode) => {
                // The journal is written before moving any value. Every process finishes the
                // same transition under store.lock before serving a read or mutation.
                match mode {
                    SecretStorageMode::Encrypted => {
                        self.prepare()?;
                    }
                    SecretStorageMode::File => self.migrate_to_file()?,
                }
                self.write_storage_state(StorageState::Ready(mode))?;
                if mode == SecretStorageMode::File {
                    self.files.delete_path(&self.files.values.join(KEY_CHECK))?;
                }
                Ok(mode)
            }
        }
    }

    fn validate_files(&self, mode: SecretStorageMode) -> Result<(), SecretStoreError> {
        let (files, limit, master) = match mode {
            SecretStorageMode::Encrypted => (&self.files, encrypted_limit(), Some(self.prepare()?)),
            SecretStorageMode::File => (&self.legacy, MAX_SECRET_BYTES, None),
        };
        for entry in fs::read_dir(&files.values).map_err(store_io)? {
            let entry = entry.map_err(store_io)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(invalid_data)?;
            if name != KEY_CHECK || mode == SecretStorageMode::File {
                validate_value_name(name)?;
            }
            let value = files
                .load_path(&entry.path(), limit)?
                .ok_or_else(invalid_data)?;
            if let Some(master) = &master {
                decrypt(&cipher(master)?, name, value.expose())?;
            }
        }
        Ok(())
    }

    fn migrate_to_file(&self) -> Result<(), SecretStoreError> {
        // Do not run legacy -> encrypted migration here: plaintext already written by this
        // transition is its destination, not a legacy source to move back into ciphertext.
        let master = self.encryption_key()?;
        let cipher = cipher(&master)?;
        for entry in fs::read_dir(&self.files.values).map_err(store_io)? {
            let entry = entry.map_err(store_io)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(migration_failed)?;
            if name == KEY_CHECK {
                continue;
            }
            validate_value_name(name)?;
            let ciphertext = self
                .files
                .load_path(&entry.path(), encrypted_limit())?
                .ok_or_else(migration_failed)?;
            let plaintext = decrypt(&cipher, name, ciphertext.expose())?;
            let destination = self.legacy.values.join(name);
            if self
                .legacy
                .load_path(&destination, MAX_SECRET_BYTES)?
                .is_none()
            {
                self.legacy.store_path(&destination, &plaintext)?;
            }
            let persisted = self
                .legacy
                .load_path(&destination, MAX_SECRET_BYTES)?
                .ok_or_else(migration_failed)?;
            if persisted.expose() != plaintext.expose() {
                return Err(migration_failed());
            }
            self.files.delete_path(&entry.path())?;
        }
        // Keep the witness until the mode commit. A restart can verify the original key even
        // when the last ciphertext value was already removed before interruption.
        Ok(())
    }

    fn migrate(&self, cipher: &Cipher) -> Result<(), SecretStoreError> {
        // Separate directories make legacy plaintext unambiguous, including interrupted
        // migration. Never infer plaintext from a failed ciphertext header or authentication.
        for entry in fs::read_dir(&self.legacy.values).map_err(store_io)? {
            let entry = entry.map_err(store_io)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(migration_failed)?;
            validate_value_name(name)?;
            let plaintext = self
                .legacy
                .load_path(&entry.path(), MAX_SECRET_BYTES)?
                .ok_or_else(migration_failed)?;
            let destination = self.files.values.join(name);
            if self
                .files
                .load_path(&destination, encrypted_limit())?
                .is_none()
            {
                let ciphertext = encrypt(cipher, name, plaintext.expose())?;
                self.files.store_path(&destination, &ciphertext)?;
            }
            // Read back the durable ciphertext before deleting its exact legacy value. If a
            // prior interrupted migration disagrees, keep both files for explicit recovery.
            let persisted = self
                .files
                .load_path(&destination, encrypted_limit())?
                .ok_or_else(migration_failed)?;
            if decrypt(cipher, name, persisted.expose())?.expose() != plaintext.expose() {
                return Err(migration_failed());
            }
            self.legacy.delete_path(&entry.path())?;
        }
        Ok(())
    }
}

impl SecretStore for ProfileSecretStore {
    fn storage_mode(&self) -> Result<Option<SecretStorageMode>, SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let _lock = acquire_file_lock(&self.root, &self.boundary)?;
        let mode = match self.storage_state()? {
            StorageState::Ready(mode) | StorageState::Migrating(mode) => mode,
        };
        Ok(Some(mode))
    }

    fn set_storage_mode(&self, mode: SecretStorageMode) -> Result<(), SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let _lock = acquire_file_lock(&self.root, &self.boundary)?;
        let current = self.current_mode()?;
        if current == mode {
            return Ok(());
        }
        // An empty profile can select files even when no system keyring is available. Existing
        // ciphertext always requires its original key; never invent a replacement or fallback.
        let has_ciphertext = fs::read_dir(&self.files.values)
            .map_err(store_io)?
            .map(|entry| {
                entry
                    .map(|entry| entry.file_name() != KEY_CHECK)
                    .map_err(store_io)
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .any(|value| value);
        if mode == SecretStorageMode::File && !has_ciphertext {
            self.validate_files(SecretStorageMode::File)?;
            return self.write_storage_state(StorageState::Ready(mode));
        }
        self.validate_files(current)?;
        if mode == SecretStorageMode::Encrypted {
            self.encryption_key()?;
        }
        self.write_storage_state(StorageState::Migrating(mode))?;
        self.current_mode()?;
        Ok(())
    }

    fn check_availability(&self) -> Result<(), SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let _lock = acquire_file_lock(&self.root, &self.boundary)?;
        self.validate_files(self.current_mode()?)
    }

    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let _lock = acquire_file_lock(&self.root, &self.boundary)?;
        if self.current_mode()? == SecretStorageMode::File {
            return self.legacy.load(key);
        }
        let master = self.prepare()?;
        let path = self.files.value_path(key);
        let Some(value) = self.files.load_path(&path, encrypted_limit())? else {
            return Ok(None);
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("hashed secret key");
        decrypt(&cipher(&master)?, name, value.expose()).map(Some)
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        if value.expose().len() as u64 > MAX_SECRET_BYTES {
            return Err(backend_failure("secret value exceeds its size limit"));
        }
        let _guard = self.operations.lock().map_err(lock_error)?;
        let _lock = acquire_file_lock(&self.root, &self.boundary)?;
        if self.current_mode()? == SecretStorageMode::File {
            return self.legacy.store(key, value);
        }
        let master = self.prepare()?;
        let path = self.files.value_path(key);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("hashed secret key");
        let ciphertext = encrypt(&cipher(&master)?, name, value.expose())?;
        self.files.store_path(&path, &ciphertext)
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let _lock = acquire_file_lock(&self.root, &self.boundary)?;
        if self.current_mode()? == SecretStorageMode::File {
            return self.legacy.delete(key);
        }
        self.prepare()?;
        self.files.delete_path(&self.files.value_path(key))
    }
}

fn validate_value_name(name: &str) -> Result<(), SecretStoreError> {
    if name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(migration_failed())
    }
}

fn acquire_file_lock(
    root: &Path,
    boundary: &CanonicalPathRoot,
) -> Result<fs::File, SecretStoreError> {
    let path = root.join("store.lock");
    if inspect_path(boundary, &path)? == NoSymlinkPathStatus::Existing
        && !fs::symlink_metadata(&path).map_err(store_io)?.is_file()
    {
        return Err(backend_failure("secret storage lock is not a regular file"));
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(store_io)?;
    FileExt::lock_exclusive(&file).map_err(store_io)?;
    // Closing this separately opened handle releases the process-shared lock on all platforms.
    Ok(file)
}

fn cipher(key: &SecretValue) -> Result<Cipher, SecretStoreError> {
    Cipher::new_from_slice(key.expose()).map_err(|_| invalid_data())
}

fn encrypt(cipher: &Cipher, name: &str, value: &[u8]) -> Result<SecretValue, SecretStoreError> {
    let mut nonce = [0; NONCE_BYTES];
    getrandom::getrandom(&mut nonce)
        .map_err(|_| backend_failure("secret encryption nonce generation failed"))?;
    let mut ciphertext = Vec::with_capacity(value.len() + ENVELOPE_BYTES);
    ciphertext.extend_from_slice(HEADER);
    ciphertext.extend_from_slice(&nonce);
    ciphertext.extend_from_slice(
        &cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: value,
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| backend_failure("secret encryption failed"))?,
    );
    Ok(SecretValue::new(ciphertext))
}

fn decrypt(cipher: &Cipher, name: &str, value: &[u8]) -> Result<SecretValue, SecretStoreError> {
    if value.len() < ENVELOPE_BYTES || !value.starts_with(HEADER) {
        return Err(invalid_data());
    }
    let nonce = &value[HEADER.len()..HEADER.len() + NONCE_BYTES];
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: &value[HEADER.len() + NONCE_BYTES..],
                aad: name.as_bytes(),
            },
        )
        .map(SecretValue::new)
        .map_err(|_| invalid_data())
}

fn encrypted_limit() -> u64 {
    MAX_SECRET_BYTES + ENVELOPE_BYTES as u64
}

fn invalid_data() -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::InvalidData,
        "encrypted secret data is invalid",
    )
}

fn migration_failed() -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::MigrationFailed,
        "secret storage migration failed",
    )
}

#[cfg(test)]
#[path = "encrypted_file_tests.rs"]
mod tests;
