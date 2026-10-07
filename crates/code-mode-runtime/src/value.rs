use ash_code_mode_protocol::OutputItem;
use serde_json::Value as JsonValue;

const IMAGE_HELPER_ERROR: &str =
    "image expects a data URI string or an object with image_url and optional detail";

pub(super) fn serialize_output_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<String, String> {
    if value.is_undefined()
        || value.is_null()
        || value.is_boolean()
        || value.is_number()
        || value.is_big_int()
        || value.is_string()
    {
        return Ok(value.to_rust_string_lossy(scope));
    }
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let mut tc = tc.init();
    let Some(stringified) = v8::json::stringify(&tc, value) else {
        return Err(tc
            .exception()
            .map(|exception| value_to_error_text(&mut tc, exception))
            .unwrap_or_else(|| "failed to stringify JavaScript output".into()));
    };
    Ok(stringified.to_rust_string_lossy(&tc))
}

pub(super) fn v8_value_to_json(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<JsonValue, String> {
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let mut tc = tc.init();
    let Some(stringified) = v8::json::stringify(&tc, value) else {
        return Err(tc
            .exception()
            .map(|exception| value_to_error_text(&mut tc, exception))
            .unwrap_or_else(|| "only JSON-compatible values may cross the tool boundary".into()));
    };
    serde_json::from_str(&stringified.to_rust_string_lossy(&tc))
        .map_err(|error| format!("failed to serialize JavaScript value: {error}"))
}

pub(super) fn json_to_v8<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: &JsonValue,
) -> Result<v8::Local<'s, v8::Value>, String> {
    let json = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let json = v8::String::new(scope, &json)
        .ok_or_else(|| "failed to allocate JavaScript value".to_string())?;
    v8::json::parse(scope, json).ok_or_else(|| "failed to parse JSON value in V8".to_string())
}

pub(super) fn normalize_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    detail_override: Option<String>,
) -> Result<OutputItem, String> {
    let (image_url, object_detail) = if value.is_string() {
        (value.to_rust_string_lossy(scope), None)
    } else if let Ok(object) = v8::Local::<v8::Object>::try_from(value) {
        let url_key = v8::String::new(scope, "image_url")
            .ok_or_else(|| "failed to allocate image helper key".to_string())?;
        let image_url = object
            .get(scope, url_key.into())
            .ok_or_else(|| IMAGE_HELPER_ERROR.to_string())?;
        if !image_url.is_string() {
            return Err(IMAGE_HELPER_ERROR.into());
        }
        let detail_key = v8::String::new(scope, "detail")
            .ok_or_else(|| "failed to allocate image helper key".to_string())?;
        let detail = object
            .get(scope, detail_key.into())
            .and_then(|detail| (!detail.is_undefined() && !detail.is_null()).then_some(detail))
            .map(|detail| {
                if detail.is_string() {
                    Ok(detail.to_rust_string_lossy(scope))
                } else {
                    Err("image detail must be a string when provided".to_string())
                }
            })
            .transpose()?;
        (image_url.to_rust_string_lossy(scope), detail)
    } else {
        return Err(IMAGE_HELPER_ERROR.into());
    };

    let Some((scheme, _)) = image_url.split_once(':') else {
        return Err("image output must be a data URI".into());
    };
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        return Err("remote image URLs are not allowed in Code Mode output".into());
    }
    if !scheme.eq_ignore_ascii_case("data") || image_url.len() <= 5 {
        return Err("image output must be a non-empty data URI".into());
    }

    let detail = detail_override.or(object_detail).map(|detail| {
        let detail = detail.to_ascii_lowercase();
        match detail.as_str() {
            "auto" | "low" | "high" | "original" => Ok(detail),
            _ => Err("image detail must be one of: auto, low, high, original".to_string()),
        }
    });
    let detail = detail.transpose()?;
    Ok(OutputItem::Image { image_url, detail })
}

pub(super) fn value_to_error_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> String {
    if value.is_object()
        && let Ok(object) = v8::Local::<v8::Object>::try_from(value)
        && let Some(key) = v8::String::new(scope, "stack")
        && let Some(stack) = object.get(scope, key.into())
        && stack.is_string()
    {
        return stack.to_rust_string_lossy(scope);
    }
    value.to_rust_string_lossy(scope)
}

pub(super) fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        scope.throw_exception(message.into());
    }
}
