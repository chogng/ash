use std::sync::Arc;
use std::sync::Mutex;

use ash_async_utils::CancellationSource;
use ash_attachments::Attachments;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;
use ash_protocol::InputItem;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;

use super::AttachmentModelService;
use crate::CoreError;
use crate::ModelImageInputPolicy;
use crate::ModelSelection;
use crate::ModelService;
use core_api::ModelImageInputLimits;

#[test]
fn provider_receives_ephemeral_data_url_instead_of_durable_attachment_reference() {
    let attachments = Arc::new(Attachments::in_memory());
    let attachment = attachments
        .import_data_url(
            &crate::test_image::one_pixel_png_data_url(),
            ImageDetail::Auto,
        )
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
fn selected_model_policy_downsamples_only_the_provider_request_clone() {
    let attachments = Arc::new(Attachments::in_memory());
    let attachment = attachments
        .import_bytes(test_png(2_400, 1_200), ImageDetail::Auto)
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
