use github::Error;
pub(crate) fn validate_status<'a>(
    status: u16,
    headers: impl Iterator<Item = (&'a str, &'a str)>,
) -> Result<(), Error> {
    let throttled = headers.into_iter().any(|(name, value)| {
        (name.eq_ignore_ascii_case("x-ratelimit-remaining") && value.trim() == "0")
            || (name.eq_ignore_ascii_case("retry-after") && value.trim().parse::<u64>().is_ok())
    });
    match status {
        200..=299 => Ok(()),
        401 => Err(Error::AuthenticationRequired),
        403 if throttled => Err(Error::RateLimited),
        403 => Err(Error::PermissionDenied),
        404 => Err(Error::NotFound),
        409 => Err(Error::Conflict("GitHub resource changed".into())),
        422 => Err(Error::InvalidInput(
            "GitHub rejected the request parameters".into(),
        )),
        429 => Err(Error::RateLimited),
        _ => Err(Error::OperationFailed(format!(
            "GitHub request failed with HTTP {status}"
        ))),
    }
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod tests;
