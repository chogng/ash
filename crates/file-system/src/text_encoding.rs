use encoding_rs::Encoding;
use std::fmt;

/// A failed conversion must not publish replacement characters or numeric references to disk.
#[derive(Debug, PartialEq, Eq)]
pub enum TextEncodingError {
    Unsupported,
    InvalidText,
    Unmappable,
}

impl fmt::Display for TextEncodingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unsupported => "unsupported file encoding",
            Self::InvalidText => "file is not text in the selected encoding",
            Self::Unmappable => "text contains characters unavailable in the selected encoding",
        })
    }
}

impl std::error::Error for TextEncodingError {}

pub struct DecodedText {
    pub text: String,
    pub encoding: String,
}

enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Latin1,
    Legacy(&'static Encoding),
}

impl TextEncoding {
    fn parse(id: &str) -> Result<Self, TextEncodingError> {
        Ok(match id {
            "utf8" => Self::Utf8,
            "utf8bom" => Self::Utf8Bom,
            "utf16le" => Self::Utf16Le,
            "utf16be" => Self::Utf16Be,
            // WHATWG aliases ISO-8859-1 to Windows-1252, but editor files need the actual codec.
            "iso88591" => Self::Latin1,
            other => {
                let label = match other {
                    "windows1250" => "windows-1250",
                    "windows1251" => "windows-1251",
                    "windows1252" => "windows-1252",
                    "windows1253" => "windows-1253",
                    "windows1254" => "windows-1254",
                    "windows1255" => "windows-1255",
                    "windows1256" => "windows-1256",
                    "windows1257" => "windows-1257",
                    "windows1258" => "windows-1258",
                    "windows874" => "windows-874",
                    "iso88592" => "iso-8859-2",
                    "iso88593" => "iso-8859-3",
                    "iso88594" => "iso-8859-4",
                    "iso88595" => "iso-8859-5",
                    "iso88596" => "iso-8859-6",
                    "iso88597" => "iso-8859-7",
                    "iso88598" => "iso-8859-8",
                    "iso885910" => "iso-8859-10",
                    "iso885913" => "iso-8859-13",
                    "iso885914" => "iso-8859-14",
                    "iso885915" => "iso-8859-15",
                    "iso885916" => "iso-8859-16",
                    "cp866" => "ibm866",
                    "koi8r" => "koi8-r",
                    "koi8u" => "koi8-u",
                    "gbk" => "gbk",
                    "gb18030" => "gb18030",
                    "big5" => "big5",
                    "shiftjis" => "shift_jis",
                    "eucjp" => "euc-jp",
                    "euckr" => "euc-kr",
                    _ => return Err(TextEncodingError::Unsupported),
                };
                Self::Legacy(
                    Encoding::for_label(label.as_bytes()).ok_or(TextEncodingError::Unsupported)?,
                )
            }
        })
    }
}

/// `auto` recognizes Unicode BOMs, otherwise uses strict UTF-8. It does not guess legacy codecs.
pub fn decode_text(bytes: &[u8], requested: &str) -> Result<DecodedText, TextEncodingError> {
    let detected = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(("utf8bom", 3))
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        Some(("utf16le", 2))
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some(("utf16be", 2))
    } else {
        None
    };
    let id = if requested == "auto" {
        detected.map_or("utf8", |(id, _)| id)
    } else if requested == "utf8" && detected.is_some_and(|(id, _)| id == "utf8bom") {
        "utf8bom"
    } else {
        requested
    };
    let codec = TextEncoding::parse(id)?;
    let offset = detected
        .filter(|(bom, _)| *bom == id)
        .map_or(0, |(_, offset)| offset);
    let bytes = &bytes[offset..];
    let text = match codec {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => std::str::from_utf8(bytes)
            .map_err(|_| TextEncodingError::InvalidText)?
            .to_owned(),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if !bytes.len().is_multiple_of(2) {
                return Err(TextEncodingError::InvalidText);
            }
            let units = bytes
                .chunks_exact(2)
                .map(|pair| {
                    if id == "utf16le" {
                        u16::from_le_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_be_bytes([pair[0], pair[1]])
                    }
                })
                .collect::<Vec<_>>();
            String::from_utf16(&units).map_err(|_| TextEncodingError::InvalidText)?
        }
        TextEncoding::Latin1 => bytes.iter().map(|byte| char::from(*byte)).collect(),
        TextEncoding::Legacy(codec) => {
            let (text, errors) = codec.decode_without_bom_handling(bytes);
            if errors {
                return Err(TextEncodingError::InvalidText);
            }
            text.into_owned()
        }
    };
    let mut count = 0;
    let mut controls = 0;
    for ch in text.chars().take(8192) {
        if ch == '\0' {
            return Err(TextEncodingError::InvalidText);
        }
        if ch < '\u{0009}' || (ch > '\u{000d}' && ch < '\u{0020}') {
            controls += 1;
        }
        count += 1;
    }
    if controls * 10 > count {
        return Err(TextEncodingError::InvalidText);
    }
    Ok(DecodedText {
        text,
        encoding: id.to_owned(),
    })
}

/// UTF-16 output is explicit: encoding_rs encoders intentionally substitute UTF-8 for UTF-16.
pub fn encode_text(text: &str, encoding: &str) -> Result<Vec<u8>, TextEncodingError> {
    Ok(match TextEncoding::parse(encoding)? {
        TextEncoding::Utf8 => text.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat(),
        TextEncoding::Utf16Le => [
            vec![0xff, 0xfe],
            text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat(),
        TextEncoding::Utf16Be => [
            vec![0xfe, 0xff],
            text.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        ]
        .concat(),
        TextEncoding::Latin1 => text
            .chars()
            .map(|ch| u8::try_from(u32::from(ch)).map_err(|_| TextEncodingError::Unmappable))
            .collect::<Result<Vec<_>, _>>()?,
        TextEncoding::Legacy(codec) => {
            let (bytes, _, errors) = codec.encode(text);
            if errors {
                return Err(TextEncodingError::Unmappable);
            }
            bytes.into_owned()
        }
    })
}

#[cfg(test)]
#[path = "text_encoding_tests.rs"]
mod tests;
