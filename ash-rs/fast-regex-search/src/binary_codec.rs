use crate::FastRegexError;
use crate::path_codec;
use crate::storage::corrupt;
use std::path::Path;
use std::path::PathBuf;

pub(crate) fn write_bytes(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value);
}

pub(crate) fn write_path(output: &mut Vec<u8>, path: &Path) {
    write_bytes(output, &path_codec::encode(path));
}

pub(crate) fn write_grams(output: &mut Vec<u8>, grams: &[u64]) {
    output.extend_from_slice(&(grams.len() as u64).to_le_bytes());
    for gram in grams {
        output.extend_from_slice(&gram.to_le_bytes());
    }
}

pub(crate) struct Reader<'a> {
    path: &'a Path,
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(path: &'a Path, bytes: &'a [u8]) -> Self {
        Self {
            path,
            bytes,
            offset: 0,
        }
    }

    pub(crate) fn source_path(&self) -> &Path {
        self.path
    }

    pub(crate) fn take(&mut self, length: usize) -> Result<&[u8], FastRegexError> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| corrupt(self.path))?;
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, FastRegexError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, FastRegexError> {
        let bytes = self.take(4)?.try_into().expect("four bytes");
        Ok(u32::from_le_bytes(bytes))
    }

    pub(crate) fn u64(&mut self) -> Result<u64, FastRegexError> {
        let bytes = self.take(8)?.try_into().expect("eight bytes");
        Ok(u64::from_le_bytes(bytes))
    }

    fn usize_from_u32(&mut self) -> Result<usize, FastRegexError> {
        usize::try_from(self.u32()?).map_err(|_| corrupt(self.path))
    }

    pub(crate) fn usize(&mut self) -> Result<usize, FastRegexError> {
        usize::try_from(self.u64()?).map_err(|_| corrupt(self.path))
    }

    pub(crate) fn string(&mut self) -> Result<String, FastRegexError> {
        String::from_utf8(self.length_prefixed_bytes()?.to_vec()).map_err(|_| corrupt(self.path))
    }

    fn length_prefixed_bytes(&mut self) -> Result<&[u8], FastRegexError> {
        let length = self.usize_from_u32()?;
        self.take(length)
    }

    pub(crate) fn path(&mut self) -> Result<PathBuf, FastRegexError> {
        path_codec::decode(self.length_prefixed_bytes()?).map_err(|()| corrupt(self.path))
    }

    pub(crate) fn grams(&mut self) -> Result<Vec<u64>, FastRegexError> {
        let count = self.usize()?;
        let byte_count = count.checked_mul(8).ok_or_else(|| corrupt(self.path))?;
        if byte_count > self.remaining().len() {
            return Err(corrupt(self.path));
        }
        let mut grams = Vec::with_capacity(count);
        for _ in 0..count {
            let gram = self.u64()?;
            if gram > u64::from(u32::MAX)
                || grams.last().is_some_and(|previous| {
                    crate::trigram::key(*previous) >= crate::trigram::key(gram)
                })
            {
                return Err(corrupt(self.path));
            }
            grams.push(gram);
        }
        Ok(grams)
    }

    pub(crate) fn remaining(&self) -> &[u8] {
        &self.bytes[self.offset..]
    }

    pub(crate) fn finish(&self) -> Result<(), FastRegexError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(corrupt(self.path))
        }
    }
}
