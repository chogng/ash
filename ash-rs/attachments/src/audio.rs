use crate::AttachmentError;
use crate::Attachments;
use ::audio::AudioFormat;
use ::audio::EncodedAudio;
use ash_protocol::AudioAttachmentRef;
use ash_protocol::AudioMediaType;
use ash_protocol::ContentDigest;

impl Attachments {
    /// Validates an inline audio upload and commits bytes before returning its reference.
    pub fn import_audio_data_url(&self, url: &str) -> Result<AudioAttachmentRef, AttachmentError> {
        let audio = ::audio::load_data_url(url)
            .map_err(|error| AttachmentError::InvalidAudio(error.to_string()))?;
        self.commit_audio(audio)
    }

    pub fn import_audio_bytes(
        &self,
        bytes: Vec<u8>,
        media_type: AudioMediaType,
    ) -> Result<AudioAttachmentRef, AttachmentError> {
        let audio = ::audio::load_bytes(bytes.into(), format_for_media_type(media_type))
            .map_err(|error| AttachmentError::InvalidAudio(error.to_string()))?;
        self.commit_audio(audio)
    }

    pub fn verify_audio(&self, reference: &AudioAttachmentRef) -> Result<(), AttachmentError> {
        self.read_audio(reference).map(|_| ())
    }

    /// Resolves a verified audio reference only for the outgoing model request.
    pub fn materialize_audio_data_url(
        &self,
        reference: &AudioAttachmentRef,
    ) -> Result<String, AttachmentError> {
        Ok(self.read_audio(reference)?.data_url())
    }

    fn commit_audio(&self, audio: EncodedAudio) -> Result<AudioAttachmentRef, AttachmentError> {
        let reference = reference_for_audio(&audio);
        self.store.put(audio.bytes().clone())?;
        Ok(reference)
    }

    fn read_audio(&self, reference: &AudioAttachmentRef) -> Result<EncodedAudio, AttachmentError> {
        if reference.duration_ms == 0 || reference.duration_ms > ::audio::MAX_AUDIO_DURATION_MS {
            return Err(AttachmentError::Corrupt);
        }
        let bytes = self
            .store
            .read(&reference.content_digest, reference.encoded_bytes)?;
        let audio = ::audio::load_bytes(bytes, format_for_media_type(reference.media_type))
            .map_err(|_| AttachmentError::Corrupt)?;
        if reference_for_audio(&audio) != *reference {
            return Err(AttachmentError::Corrupt);
        }
        Ok(audio)
    }
}

fn reference_for_audio(audio: &EncodedAudio) -> AudioAttachmentRef {
    AudioAttachmentRef {
        content_digest: ContentDigest::sha256(audio.bytes()),
        media_type: match audio.format() {
            AudioFormat::Wav => AudioMediaType::Wav,
            AudioFormat::Mp3 => AudioMediaType::Mp3,
            AudioFormat::M4a => AudioMediaType::M4a,
            AudioFormat::WebM => AudioMediaType::WebM,
            AudioFormat::Ogg => AudioMediaType::Ogg,
        },
        encoded_bytes: audio.bytes().len() as u64,
        duration_ms: audio.duration_ms(),
    }
}

fn format_for_media_type(media_type: AudioMediaType) -> AudioFormat {
    match media_type {
        AudioMediaType::Wav => AudioFormat::Wav,
        AudioMediaType::Mp3 => AudioFormat::Mp3,
        AudioMediaType::M4a => AudioFormat::M4a,
        AudioMediaType::WebM => AudioFormat::WebM,
        AudioMediaType::Ogg => AudioFormat::Ogg,
    }
}
