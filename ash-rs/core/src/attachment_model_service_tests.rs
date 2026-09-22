use std::sync::Arc;
use std::sync::Mutex;

use ash_async_utils::CancellationSource;
use ash_attachments::Attachments;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;
use ash_protocol::InputItem;
use ash_protocol::ModelImageInputLimits;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;

use super::AttachmentModelService;
use crate::ContextTokenMeasurementOutcome;
use crate::CoreError;
use crate::ModelImageInputPolicy;
use crate::ModelSelection;
use crate::ModelService;
use attachment_store::FileAttachmentStore;

#[test]
fn provider_receives_ephemeral_data_url_instead_of_durable_attachment_reference() {
    let attachments = Arc::new(Attachments::in_memory());
    let attachment = attachments
        .import_data_url(&crate::test_image::one_pixel_png_data_url())
        .unwrap();
    let mut request = ModelRequest::text("describe this image");
    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("text request must contain one message");
    };
    message.content.push(ContentPart::ImageAttachment {
        attachment,
        detail: ImageDetail::High,
    });
    let provider = Arc::new(RecordingModel::default());
    let service = AttachmentModelService::new(provider.clone(), attachments);

    service
        .invoke(
            ModelSelection::ConfiguredDefault,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(
        &provider.request.lock().unwrap().as_ref().unwrap().input[0],
        InputItem::Message(message)
            if matches!(
                &message.content[1],
                ContentPart::ImageUrl { url, detail: ImageDetail::High }
                    if url.starts_with("data:image/png;base64,")
            )
    ));
    assert!(matches!(
        &request.input[0],
        InputItem::Message(message)
            if matches!(&message.content[1], ContentPart::ImageAttachment { .. })
    ));
}

#[test]
fn audio_is_materialized_only_in_the_provider_request() {
    let attachments = Arc::new(Attachments::in_memory());
    let attachment = attachments
        .import_audio_bytes(
            include_bytes!("../../utils/audio/tests/fixtures/tone.wav").to_vec(),
            ash_protocol::AudioMediaType::Wav,
        )
        .unwrap();
    let mut request = ModelRequest::text("describe the recording");
    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("expected message")
    };
    message
        .content
        .push(ContentPart::AudioAttachment { attachment });
    let original = request.clone();
    let provider = Arc::new(RecordingModel::default());
    let service = AttachmentModelService::new(provider.clone(), attachments);
    service
        .invoke(
            ModelSelection::ConfiguredDefault,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(request, original);
    let captured = provider.request.lock().unwrap();
    let InputItem::Message(message) = &captured.as_ref().unwrap().input[0] else {
        panic!("expected message")
    };
    assert!(
        matches!(&message.content[1], ContentPart::AudioUrl { url } if url.starts_with("data:audio/wav;base64,"))
    );
}

#[test]
fn inline_audio_measurement_and_invocation_do_not_write_attachment_storage() {
    let root = tempfile::tempdir().unwrap();
    let attachments = Arc::new(Attachments::new(Arc::new(
        FileAttachmentStore::open(root.path()).unwrap(),
    )));
    let source = audio::load_bytes(
        include_bytes!("../../utils/audio/tests/fixtures/tone.wav")
            .as_slice()
            .into(),
        audio::AudioFormat::Wav,
    )
    .unwrap()
    .data_url();
    let mut request = ModelRequest::text("describe the recording");
    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("expected message")
    };
    message.content.push(ContentPart::AudioUrl { url: source });
    let original = request.clone();
    let provider = Arc::new(RecordingModel::default());
    let service = AttachmentModelService::new(provider.clone(), attachments);
    let cancellation = CancellationSource::new().token();

    service
        .measure_input(ModelSelection::ConfiguredDefault, &request, &cancellation)
        .unwrap();
    assert_eq!(provider.request.lock().unwrap().as_ref(), Some(&original));
    assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());

    service
        .invoke(ModelSelection::ConfiguredDefault, &request, &cancellation)
        .unwrap();
    assert_eq!(provider.request.lock().unwrap().as_ref(), Some(&original));
    assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    assert_eq!(request, original);

    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("expected message")
    };
    message.content[1] = ContentPart::AudioUrl {
        url: "data:audio/wav;base64,Y29ycnVwdA==".into(),
    };
    *provider.request.lock().unwrap() = None;
    assert!(
        service
            .measure_input(ModelSelection::ConfiguredDefault, &request, &cancellation)
            .is_err()
    );
    assert!(
        service
            .invoke(ModelSelection::ConfiguredDefault, &request, &cancellation)
            .is_err()
    );
    assert!(provider.request.lock().unwrap().is_none());
    assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
}

#[test]
fn selected_model_policy_downsamples_only_the_provider_request_clone() {
    let attachments = Arc::new(Attachments::in_memory());
    let attachment = attachments
        .import_bytes(test_png(2_400, 1_200), ash_protocol::ImageMediaType::Png)
        .unwrap();
    let mut request = ModelRequest::text("describe this image");
    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("text request must contain one message");
    };
    message.content.push(ContentPart::ImageAttachment {
        attachment: attachment.clone(),
        detail: ImageDetail::Auto,
    });
    let limited = ModelImageInputLimits::new(1_000, 1_000);
    let provider = Arc::new(RecordingModel::with_policy(ModelImageInputPolicy::new(
        limited, limited, limited, limited,
    )));
    let service = AttachmentModelService::new(provider.clone(), attachments.clone());

    service
        .invoke(
            ModelSelection::ConfiguredDefault,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap();

    let recorded = provider.request.lock().unwrap();
    let InputItem::Message(message) = &recorded.as_ref().unwrap().input[0] else {
        panic!("recorded request must contain the user message");
    };
    let ContentPart::ImageUrl { url, .. } = &message.content[1] else {
        panic!("provider request must materialize the attachment");
    };
    let image = ash_utils_image::load_data_url_for_prompt(
        url,
        ash_utils_image::PromptImagePolicy::for_mode(ash_utils_image::PromptImageMode::Original),
    )
    .unwrap();
    assert!(image.width <= 1_000);
    assert!(image.height <= 1_000);
    assert_eq!((attachment.width, attachment.height), (2_400, 1_200));
    assert!(attachments.verify(&attachment).is_ok());
    assert!(matches!(
        &request.input[0],
        InputItem::Message(message)
            if matches!(&message.content[1], ContentPart::ImageAttachment { attachment: durable, .. } if durable == &attachment)
    ));
}

#[test]
fn legacy_inline_data_urls_use_the_same_ephemeral_provider_policy() {
    let source_url = ash_utils_image::data_url_from_bytes("image/png", &test_png(2_400, 1_200));
    let mut request = ModelRequest::text("describe this legacy image");
    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("text request must contain one message");
    };
    message.content.push(ContentPart::ImageUrl {
        url: source_url.clone(),
        detail: ImageDetail::Auto,
    });
    let limited = ModelImageInputLimits::new(1_000, 1_000);
    let provider = Arc::new(RecordingModel::with_policy(ModelImageInputPolicy::new(
        limited, limited, limited, limited,
    )));
    let service = AttachmentModelService::new(provider.clone(), Arc::new(Attachments::in_memory()));

    service
        .invoke(
            ModelSelection::ConfiguredDefault,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap();

    let recorded = provider.request.lock().unwrap();
    let InputItem::Message(message) = &recorded.as_ref().unwrap().input[0] else {
        panic!("recorded request must contain the user message");
    };
    let ContentPart::ImageUrl { url, .. } = &message.content[1] else {
        panic!("provider request must retain an inline image URL");
    };
    let image = ash_utils_image::load_data_url_for_prompt(
        url,
        ash_utils_image::PromptImagePolicy::for_mode(ash_utils_image::PromptImageMode::Original),
    )
    .unwrap();
    assert!(image.width <= 1_000);
    assert!(image.height <= 1_000);
    assert!(matches!(
        &request.input[0],
        InputItem::Message(message)
            if matches!(&message.content[1], ContentPart::ImageUrl { url, .. } if url == &source_url)
    ));
}

struct RecordingModel {
    request: Mutex<Option<ModelRequest>>,
    image_policy: ModelImageInputPolicy,
}

impl Default for RecordingModel {
    fn default() -> Self {
        Self {
            request: Mutex::new(None),
            image_policy: ModelImageInputPolicy::default(),
        }
    }
}

impl RecordingModel {
    fn with_policy(image_policy: ModelImageInputPolicy) -> Self {
        Self {
            request: Mutex::new(None),
            image_policy,
        }
    }
}

impl ModelService for RecordingModel {
    fn measure_input(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        *self.request.lock().unwrap() = Some(request.clone());
        Ok(ContextTokenMeasurementOutcome::Unavailable)
    }

    fn image_input_policy(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ModelImageInputPolicy, CoreError> {
        Ok(self.image_policy)
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        *self.request.lock().unwrap() = Some(request.clone());
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("ok".into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

fn test_png(width: u32, height: u32) -> Vec<u8> {
    let image = image::DynamicImage::new_rgba8(width, height);
    let mut encoded = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    encoded.into_inner()
}
