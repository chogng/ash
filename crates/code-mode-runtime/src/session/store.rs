use ash_code_mode_protocol::RuntimeError;
use ash_code_mode_protocol::validate_values;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

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

    pub(crate) fn snapshot(&self) -> Result<BTreeMap<String, Value>, RuntimeError> {
        self.values
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode values were poisoned".into()))
            .map(|values| values.clone())
    }

    pub(crate) fn apply(
        &self,
        writes: BTreeMap<String, Option<Value>>,
    ) -> Result<(), RuntimeError> {
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
