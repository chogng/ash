use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::sync::Once;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use anyhow::ensure;
use candle_core::Device;
use candle_core::IndexOp;
use candle_core::Tensor;
use candle_nn::ops::softmax_last_dim;
use candle_onnx::eval::get_tensor;
use candle_onnx::onnx::ModelProto;
use prost::Message;
use tokenizers::Tokenizer;

use crate::InputClassification;
use crate::InputClassificationSource;
use crate::InputRoute;

const MODEL_BYTES: &[u8] = include_bytes!("../models/bert_tiny_v3_candle.onnx");
const TOKENIZER_BYTES: &[u8] = include_bytes!("../models/bert_tiny_tokenizer.json");
const CALIBRATION_TEMPERATURE: f64 = 1.6894922825552194;

/// Pinned classifier variant embedded in this crate.
pub const MODEL_VERSION: &str = "bert_tiny_v3_candle_fp32";
/// SHA-256 of the embedded ONNX model.
pub const MODEL_SHA256: &str = "d987f9e2c50a7c04f619423445cea4730950473ca80dc8dea149d285f631530c";
/// SHA-256 of the embedded tokenizer.
pub const TOKENIZER_SHA256: &str =
    "b43e3d508ae9fe2c557ac2e0fb82f3487d59193a58f5328dc042ebf31ba1f72c";

static CLASSIFIER: OnceLock<Result<EmbeddedClassifier, String>> = OnceLock::new();
static WARMUP_STARTED: Once = Once::new();

#[derive(Clone, Copy, Debug)]
pub(crate) enum ModelAttempt {
    Classified(InputClassification),
    Unavailable,
    Failed,
    Panicked,
}

/// Starts one best-effort background load of the embedded model and tokenizer.
pub fn start_background_warmup() {
    WARMUP_STARTED.call_once(|| {
        let _ = thread::Builder::new()
            .name("ash-input-classifier".to_owned())
            .spawn(|| {
                let _ = embedded_classifier();
            });
    });
}

pub(crate) fn classify_with_embedded_model(input: &str) -> ModelAttempt {
    match embedded_classifier() {
        Ok(classifier) => classifier.classify(input),
        Err(_) => ModelAttempt::Unavailable,
    }
}

fn embedded_classifier() -> Result<&'static EmbeddedClassifier> {
    CLASSIFIER
        .get_or_init(|| EmbeddedClassifier::load().map_err(|error| format!("{error:#}")))
        .as_ref()
        .map_err(|error| anyhow!(error.clone()))
}

struct EmbeddedClassifier {
    model: ModelProto,
    weights: HashMap<String, Tensor>,
    tokenizer: Tokenizer,
    device: Device,
    has_panicked: AtomicBool,
}

impl EmbeddedClassifier {
    fn load() -> Result<Self> {
        let mut model =
            ModelProto::decode(MODEL_BYTES).context("failed to decode embedded ONNX model")?;
        let graph = model
            .graph
            .as_mut()
            .context("classifier model has no graph")?;
        // simple_eval accepts preloaded values. Remove the protobuf initializers after decoding
        // them once so each inference clones tensor handles instead of rebuilding the weights.
        let weights = std::mem::take(&mut graph.initializer)
            .into_iter()
            .map(|initializer| {
                let tensor = get_tensor(&initializer, &initializer.name)?;
                Ok((initializer.name, tensor))
            })
            .collect::<Result<HashMap<_, _>>>()
            .context("failed to prepare classifier weights")?;
        let tokenizer = Tokenizer::from_bytes(TOKENIZER_BYTES)
            .map_err(|error| anyhow!(error))
            .context("failed to decode embedded tokenizer")?;
        Ok(Self {
            model,
            weights,
            tokenizer,
            device: Device::Cpu,
            has_panicked: AtomicBool::new(false),
        })
    }

    fn classify(&self, input: &str) -> ModelAttempt {
        if self.has_panicked.load(Ordering::Acquire) {
            return ModelAttempt::Panicked;
        }
        match catch_unwind(AssertUnwindSafe(|| self.run_inference(input))) {
            Ok(Ok(classification)) => ModelAttempt::Classified(classification),
            Ok(Err(_)) => ModelAttempt::Failed,
            Err(_) => {
                self.has_panicked.store(true, Ordering::Release);
                ModelAttempt::Panicked
            }
        }
    }

    fn run_inference(&self, input: &str) -> Result<InputClassification> {
        let encoding = self
            .tokenizer
            .encode_fast(input, true)
            .map_err(|error| anyhow!(error))
            .context("failed to tokenize classifier input")?;
        let input_ids = encoding
            .get_ids()
            .iter()
            .map(|token| i64::from(*token))
            .collect::<Vec<_>>();
        let attention_mask = encoding
            .get_attention_mask()
            .iter()
            .map(|token| i64::from(*token))
            .collect::<Vec<_>>();
        let input_ids = Tensor::new(input_ids.as_slice(), &self.device)
            .context("failed to build input_ids tensor")?
            .unsqueeze(0)?;
        let attention_mask = Tensor::new(attention_mask.as_slice(), &self.device)
            .context("failed to build attention_mask tensor")?
            .unsqueeze(0)?;
        let mut inputs = self.weights.clone();
        inputs.insert("input_ids".to_owned(), input_ids);
        inputs.insert("attention_mask".to_owned(), attention_mask);
        let outputs = candle_onnx::simple_eval(&self.model, inputs)
            .context("failed to evaluate embedded ONNX model")?;
        let logits = outputs
            .get("logits")
            .context("classifier model did not return logits")?;
        let calibrated_logits = logits
            .affine(1.0 / CALIBRATION_TEMPERATURE, 0.0)
            .context("failed to calibrate classifier logits")?;
        let probabilities = softmax_last_dim(&calibrated_logits)
            .context("failed to normalize classifier logits")?
            .i(0)?
            .to_vec1::<f32>()?;
        ensure!(
            probabilities.len() == 2,
            "classifier returned an invalid label count"
        );
        let shell_probability = probabilities[0];
        let agent_probability = probabilities[1];
        ensure!(
            shell_probability.is_finite() && agent_probability.is_finite(),
            "classifier returned non-finite probabilities"
        );
        let (route, confidence) = if shell_probability > agent_probability {
            (InputRoute::Shell, shell_probability)
        } else {
            (InputRoute::Agent, agent_probability)
        };
        Ok(InputClassification {
            route,
            confidence,
            source: InputClassificationSource::Model,
        })
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
