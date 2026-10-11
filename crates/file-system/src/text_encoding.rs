use chardetng::EncodingDetector;
use chardetng::Iso2022JpDetection;
use chardetng::Utf8Detection;
use encoding_rs::Encoding;

#[path = "text_encoding_tables.rs"]
mod tables;
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
    SingleByte(&'static [u32; 128]),
    DoubleByte(DoubleByteEncoding),
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
            "iso88599" => Self::SingleByte(&tables::ISO88599),
            "iso885911" => Self::SingleByte(&tables::ISO885911),
            "cp437" => Self::SingleByte(&tables::CP437),
            "cp850" => Self::SingleByte(&tables::CP850),
            "cp852" => Self::SingleByte(&tables::CP852),
            "cp857" => Self::SingleByte(&tables::CP857),
            "cp865" => Self::SingleByte(&tables::CP865),
            "cp1125" => Self::SingleByte(&tables::CP1125),
            "koi8ru" => Self::SingleByte(&tables::KOI8RU),
            "koi8t" => Self::SingleByte(&tables::KOI8T),
            "cp950" => Self::DoubleByte(DoubleByteEncoding::Cp950),
            "big5hkscs" => Self::DoubleByte(DoubleByteEncoding::Big5Hkscs),
            "gb2312" => Self::DoubleByte(DoubleByteEncoding::Gb2312),
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
                    "macroman" => "macintosh",
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

/// `auto` recognizes Unicode BOMs and NUL-pattern UTF-16, otherwise uses strict UTF-8.
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
        detected.map_or_else(|| detect_utf16(bytes).unwrap_or("utf8"), |(id, _)| id)
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
        TextEncoding::SingleByte(table) => bytes
            .iter()
            .map(|byte| {
                if *byte < 128 {
                    return Ok(char::from(*byte));
                }
                let value = table[usize::from(*byte) - 128];
                char::from_u32(value)
                    .filter(|_| value != 0)
                    .ok_or(TextEncodingError::InvalidText)
            })
            .collect::<Result<String, _>>()?,
        TextEncoding::DoubleByte(codec) => codec.decode(bytes)?,
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
        TextEncoding::SingleByte(table) => text
            .chars()
            .map(|ch| {
                if ch.is_ascii() {
                    return Ok(ch as u8);
                }
                table
                    .iter()
                    .position(|value| *value == u32::from(ch))
                    .map(|index| (index + 128) as u8)
                    .ok_or(TextEncodingError::Unmappable)
            })
            .collect::<Result<Vec<_>, _>>()?,
        TextEncoding::DoubleByte(codec) => codec.encode(text)?,
        TextEncoding::Legacy(codec) => {
            let (bytes, _, errors) = codec.encode(text);
            if errors {
                return Err(TextEncodingError::Unmappable);
            }
            bytes.into_owned()
        }
    })
}

/// Read policy supplied by the client that owns file-encoding preferences.
#[derive(Default)]
pub struct TextDecodingOptions<'a> {
    pub encoding: Option<&'a str>,
    pub auto_guess_encoding: bool,
    pub candidate_guess_encodings: &'a [String],
}

/// BOM and UTF-16 detection precede configured fallbacks; explicit codec choices disable guessing.
pub fn decode_text_with_options(
    bytes: &[u8],
    options: &TextDecodingOptions<'_>,
) -> Result<DecodedText, TextEncodingError> {
    let preferred = options.encoding.unwrap_or("utf8");
    TextEncoding::parse(preferred)?;
    if options.candidate_guess_encodings.len() > 50 {
        return Err(TextEncodingError::Unsupported);
    }
    for candidate in options.candidate_guess_encodings {
        TextEncoding::parse(candidate)?;
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf])
        || bytes.starts_with(&[0xff, 0xfe])
        || bytes.starts_with(&[0xfe, 0xff])
    {
        return decode_text(bytes, "auto");
    }
    if let Some(id) = detect_utf16(bytes) {
        return decode_text(bytes, id);
    }
    if options.auto_guess_encoding {
        // Feed a bounded prefix without claiming EOF if a multi-byte character might be split.
        let sample = &bytes[..bytes.len().min(64 * 1024)];
        if sample.contains(&0) {
            return Err(TextEncodingError::InvalidText);
        }
        if std::str::from_utf8(bytes).is_ok() {
            return decode_text(bytes, "utf8");
        }
        if std::str::from_utf8(bytes).is_err_and(|error| error.error_len().is_none()) {
            return decode_text(bytes, preferred);
        }
        let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
        detector.feed(sample, sample.len() == bytes.len());
        let guessed = detector.guess(None, Utf8Detection::Allow);
        if let Some(id) = detector_id(guessed) {
            if (options.candidate_guess_encodings.is_empty()
                || options
                    .candidate_guess_encodings
                    .iter()
                    .any(|candidate| candidate == id))
                && let Ok(decoded) = decode_text(bytes, id)
            {
                return Ok(decoded);
            }
        }
        // An excluded/statistically indeterminate guess must not select an arbitrary candidate.
        let mut matching: Option<DecodedText> = None;
        for candidate in options.candidate_guess_encodings {
            if candidate == "utf8" || candidate == "utf8bom" || candidate.starts_with("utf16") {
                continue;
            }
            if let Ok(decoded) = decode_text(bytes, candidate)
                && encode_text(&decoded.text, candidate).is_ok_and(|encoded| encoded == bytes)
            {
                if matching
                    .as_ref()
                    .is_some_and(|previous| previous.encoding == decoded.encoding)
                {
                    continue;
                }
                if matching.is_some() {
                    return decode_text(bytes, preferred);
                }
                matching = Some(decoded);
            }
        }
        if let Some(decoded) = matching {
            return Ok(decoded);
        }
    }
    decode_text(bytes, preferred)
}

fn detector_id(encoding: &'static Encoding) -> Option<&'static str> {
    Some(match encoding.name() {
        "UTF-8" => "utf8",
        "GBK" => "gbk",
        "gb18030" => "gb18030",
        "Big5" => "cp950",
        "Shift_JIS" => "shiftjis",
        "EUC-JP" => "eucjp",
        "EUC-KR" => "euckr",
        "IBM866" => "cp866",
        "KOI8-R" => "koi8r",
        "KOI8-U" => "koi8u",
        "macintosh" => "macroman",
        "windows-1250" => "windows1250",
        "windows-1251" => "windows1251",
        "windows-1252" => "windows1252",
        "windows-1253" => "windows1253",
        "windows-1254" => "windows1254",
        "windows-1255" => "windows1255",
        "windows-1256" => "windows1256",
        "windows-1257" => "windows1257",
        "windows-1258" => "windows1258",
        "windows-874" => "windows874",
        "ISO-8859-2" => "iso88592",
        "ISO-8859-3" => "iso88593",
        "ISO-8859-4" => "iso88594",
        "ISO-8859-5" => "iso88595",
        "ISO-8859-6" => "iso88596",
        "ISO-8859-7" => "iso88597",
        "ISO-8859-8" | "ISO-8859-8-I" => "iso88598",
        "ISO-8859-10" => "iso885910",
        "ISO-8859-13" => "iso885913",
        "ISO-8859-14" => "iso885914",
        "ISO-8859-15" => "iso885915",
        "ISO-8859-16" => "iso885916",
        _ => return None,
    })
}

fn detect_utf16(bytes: &[u8]) -> Option<&'static str> {
    let sample = &bytes[..bytes.len().min(512)];
    if sample.len() < 4 {
        return None;
    }
    let pairs = sample.chunks_exact(2);
    let count = pairs.len();
    let mut even = 0;
    let mut odd = 0;
    for pair in pairs {
        even += usize::from(pair[0] == 0);
        odd += usize::from(pair[1] == 0);
    }
    if odd * 2 >= count && even == 0 {
        Some("utf16le")
    } else if even * 2 >= count && odd == 0 {
        Some("utf16be")
    } else {
        None
    }
}

// The editor needs separate CP950 and HKSCS tables: WHATWG Big5 encoders exclude
// some HKSCS extensions, and the two codecs differ on duplicate and supplementary mappings.
enum DoubleByteEncoding {
    Cp950,
    Big5Hkscs,
    Gb2312,
}
const HKSCS_SEQUENCES: [&str; 4] = [
    "\u{00ca}\u{0304}",
    "\u{00ca}\u{030c}",
    "\u{00ea}\u{0304}",
    "\u{00ea}\u{030c}",
];
impl DoubleByteEncoding {
    fn table(&self) -> (&'static [u8], usize, usize) {
        match self {
            Self::Cp950 => (include_bytes!("text_encoding_cp950.bin"), 2, 0xa1),
            Self::Gb2312 => (include_bytes!("text_encoding_gb2312.bin"), 2, 0xa1),
            Self::Big5Hkscs => (include_bytes!("text_encoding_big5hkscs.bin"), 4, 0x81),
        }
    }
    fn scalar(&self, index: usize) -> u32 {
        let (table, width, _) = self.table();
        let offset = index * width;
        match self {
            Self::Cp950 | Self::Gb2312 => {
                u32::from(u16::from_le_bytes([table[offset], table[offset + 1]]))
            }
            Self::Big5Hkscs => u32::from_le_bytes([
                table[offset],
                table[offset + 1],
                table[offset + 2],
                table[offset + 3],
            ]),
        }
    }
    fn pair(&self, index: usize) -> [u8; 2] {
        let column = index % self.columns();
        [
            (index / self.columns() + self.table().2) as u8,
            (if matches!(self, Self::Gb2312) {
                column + 0xa1
            } else if column < 63 {
                column + 0x40
            } else {
                column - 63 + 0xa1
            }) as u8,
        ]
    }
    fn columns(&self) -> usize {
        if matches!(self, Self::Gb2312) {
            94
        } else {
            157
        }
    }
    fn decode(&self, bytes: &[u8]) -> Result<String, TextEncodingError> {
        let (table, width, first) = self.table();
        let mut text = String::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            let lead = bytes[index];
            if lead < 128 {
                text.push(char::from(lead));
                index += 1;
                continue;
            }
            let trail = *bytes.get(index + 1).ok_or(TextEncodingError::InvalidText)?;
            let column = if matches!(self, Self::Gb2312) {
                if !(0xa1..=0xfe).contains(&trail) {
                    return Err(TextEncodingError::InvalidText);
                }
                usize::from(trail - 0xa1)
            } else {
                match trail {
                    0x40..=0x7e => usize::from(trail - 0x40),
                    0xa1..=0xfe => usize::from(trail - 0xa1) + 63,
                    _ => return Err(TextEncodingError::InvalidText),
                }
            };
            let slot = usize::from(lead)
                .checked_sub(first)
                .ok_or(TextEncodingError::InvalidText)?
                * self.columns()
                + column;
            if slot >= table.len() / width {
                return Err(TextEncodingError::InvalidText);
            }
            let value = self.scalar(slot);
            if value >= 0x110000 {
                text.push_str(HKSCS_SEQUENCES[(value - 0x110000) as usize]);
            } else {
                text.push(
                    char::from_u32(value)
                        .filter(|_| value != 0)
                        .ok_or(TextEncodingError::InvalidText)?,
                );
            }
            index += 2;
        }
        Ok(text)
    }
    fn reverse(&self) -> &'static std::collections::HashMap<u32, [u8; 2]> {
        use std::sync::LazyLock;
        static CP950: LazyLock<std::collections::HashMap<u32, [u8; 2]>> =
            LazyLock::new(|| DoubleByteEncoding::Cp950.build_reverse());
        static HKSCS: LazyLock<std::collections::HashMap<u32, [u8; 2]>> =
            LazyLock::new(|| DoubleByteEncoding::Big5Hkscs.build_reverse());
        static GB2312: LazyLock<std::collections::HashMap<u32, [u8; 2]>> =
            LazyLock::new(|| DoubleByteEncoding::Gb2312.build_reverse());
        match self {
            Self::Gb2312 => &GB2312,
            Self::Cp950 => &CP950,
            Self::Big5Hkscs => &HKSCS,
        }
    }
    fn build_reverse(&self) -> std::collections::HashMap<u32, [u8; 2]> {
        let (table, width, _) = self.table();
        let mut reverse = std::collections::HashMap::new();
        for index in 0..table.len() / width {
            let value = self.scalar(index);
            if value != 0 {
                reverse.entry(value).or_insert(self.pair(index));
            }
        }
        if matches!(self, Self::Cp950) {
            reverse.insert(0x5341, [0xa4, 0x51]);
            reverse.insert(0x5345, [0xa4, 0xca]);
        }
        reverse
    }
    fn encode(&self, text: &str) -> Result<Vec<u8>, TextEncodingError> {
        let mut bytes = Vec::with_capacity(text.len());
        let mut remaining = text;
        while !remaining.is_empty() {
            if matches!(self, Self::Big5Hkscs)
                && let Some(index) = HKSCS_SEQUENCES
                    .iter()
                    .position(|sequence| remaining.starts_with(sequence))
            {
                bytes.extend_from_slice(
                    self.reverse()
                        .get(&(0x110000 + index as u32))
                        .ok_or(TextEncodingError::Unmappable)?,
                );
                remaining = &remaining[HKSCS_SEQUENCES[index].len()..];
                continue;
            }
            let ch = remaining
                .chars()
                .next()
                .ok_or(TextEncodingError::Unmappable)?;
            if ch.is_ascii() {
                bytes.push(ch as u8);
            } else {
                bytes.extend_from_slice(
                    self.reverse()
                        .get(&u32::from(ch))
                        .ok_or(TextEncodingError::Unmappable)?,
                );
            }
            remaining = &remaining[ch.len_utf8()..];
        }
        Ok(bytes)
    }
}

#[cfg(test)]
#[path = "text_encoding_tests.rs"]
mod tests;
