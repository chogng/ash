use super::RuntimeError;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

const MAX_STORE_BYTES: usize = 16 * 1024 * 1024;

/// Bounded process-local values shared by cells in one owning Thread Session.
#[derive(Clone, Default)]
pub struct CodeModeStore {
    values: Arc<Mutex<BTreeMap<String, Value>>>,
}

impl CodeModeStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_values(values: BTreeMap<String, Value>) -> Result<Self, RuntimeError> {
        validate_values(&values).map_err(RuntimeError::InvalidRequest)?;
        Ok(Self {
            values: Arc::new(Mutex::new(values)),
        })
    }

    pub fn snapshot(&self) -> Result<BTreeMap<String, Value>, RuntimeError> {
        self.values
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode values were poisoned".into()))
            .map(|values| values.clone())
    }

    /// Atomically replaces a host snapshot, including keys deleted in that host.
    pub fn replace(&self, values: BTreeMap<String, Value>) -> Result<(), RuntimeError> {
        validate_values(&values).map_err(RuntimeError::InvalidRequest)?;
        *self
            .values
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode values were poisoned".into()))? = values;
        Ok(())
    }

    pub fn apply(&self, writes: BTreeMap<String, Option<Value>>) -> Result<(), RuntimeError> {
        let mut values = self
            .values
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode values were poisoned".into()))?;
        let mut next = values.clone();
        for (key, value) in writes {
            match value {
                Some(value) => {
                    next.insert(key, value);
                }
                None => {
                    next.remove(&key);
                }
            }
        }
        validate_values(&next).map_err(RuntimeError::InvalidRequest)?;
        *values = next;
        Ok(())
    }
}

pub fn validate_values(values: &BTreeMap<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec(values)
        .map_err(|error| error.to_string())?
        .len();
    if bytes > MAX_STORE_BYTES {
        return Err(format!(
            "Code Mode store exceeds the {MAX_STORE_BYTES} byte limit; delete unused keys with store(key, undefined)"
        ));
    }
    Ok(())
}
