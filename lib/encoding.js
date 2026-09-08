'use strict';

const DEFAULT_TEXT_ENCODING = 'utf-8';
const CENTRAL_EUROPEAN_ENCODINGS = ['windows-1250', 'iso-8859-2'];

function normalizeEncodingName(encoding) {
  if (!encoding || typeof encoding !== 'string') {
    return null;
  }
  const normalized = encoding.trim().toLowerCase();
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'latin-1') return 'latin1';
  if (normalized === 'cp1250' || normalized === 'windows1250') return 'windows-1250';
  if (normalized === 'latin2') return 'iso-8859-2';
  return normalized;
}

function extractXmlEncoding(text) {
  if (!text) return null;
  const match = text.match(/<\?xml[^>]*encoding=['"]([^'"]+)['"][^>]*\?>/i);
  return match ? match[1] : null;
}

function extractCharset(contentType) {
  if (!contentType || typeof contentType !== 'string') return null;
  const match = contentType.match(/charset=([^;]+)/i);
  return match ? match[1] : null;
}

function decodeBuffer(buffer, encoding) {
  const normalized = normalizeEncodingName(encoding);
  if (!normalized) return null;
  if (normalized === 'utf-8') return buffer.toString('utf8');
  if (normalized === 'latin1') return buffer.toString('latin1');
  if (typeof TextDecoder !== 'function') return null;
  try {
    return new TextDecoder(normalized).decode(buffer);
  } catch (error) {
    return null;
  }
}

function hasReplacementChars(text) {
  return typeof text === 'string' && text.includes('\uFFFD');
}

const ISO6937_ACUTE = '\u00C2';
const ISO6937_CARON = '\u010E';
const ISO6937_RING = '\u0118';
const ISO6937_ACUTE_MAP = {
  A: '\u00C1',
  E: '\u00C9',
  I: '\u00CD',
  O: '\u00D3',
  U: '\u00DA',
  Y: '\u00DD',
  a: '\u00E1',
  e: '\u00E9',
  i: '\u00ED',
  o: '\u00F3',
  u: '\u00FA',
  y: '\u00FD',
  C: '\u0106',
  c: '\u0107',
  N: '\u0143',
  n: '\u0144',
  R: '\u0154',
  r: '\u0155',
  S: '\u015A',
  s: '\u015B',
  Z: '\u0179',
  z: '\u017A'
};
const ISO6937_CARON_MAP = {
  C: '\u010C',
  D: '\u010E',
  E: '\u011A',
  L: '\u013D',
  N: '\u0147',
  R: '\u0158',
  S: '\u0160',
  T: '\u0164',
  Z: '\u017D',
  c: '\u010D',
  d: '\u010F',
  e: '\u011B',
  l: '\u013E',
  n: '\u0148',
  r: '\u0159',
  s: '\u0161',
  t: '\u0165',
  z: '\u017E'
};
const ISO6937_RING_MAP = {
  U: '\u016E',
  u: '\u016F'
};

function decodeIso6937(text) {
  if (!text) return text;
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === ISO6937_ACUTE) {
      const nextChar = text[index + 1];
      if (nextChar && ISO6937_ACUTE_MAP[nextChar]) {
        output += ISO6937_ACUTE_MAP[nextChar];
        index += 1;
        continue;
      }
    }
    if (char === ISO6937_CARON) {
      const nextChar = text[index + 1];
      if (nextChar && ISO6937_CARON_MAP[nextChar]) {
        output += ISO6937_CARON_MAP[nextChar];
        index += 1;
        continue;
      }
    }
    if (char === ISO6937_RING) {
      const nextChar = text[index + 1];
      if (nextChar && ISO6937_RING_MAP[nextChar]) {
        output += ISO6937_RING_MAP[nextChar];
        index += 1;
        continue;
      }
    }
    output += char;
  }
  return output;
}

function decodeEnigma2Response(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) {
    return buffer;
  }

  const asciiText = buffer.toString('latin1');
  const xmlEncoding = normalizeEncodingName(extractXmlEncoding(asciiText));
  const headerEncoding = normalizeEncodingName(extractCharset(contentType));
  const preferredEncodings = [];

  if (headerEncoding) preferredEncodings.push(headerEncoding);
  if (xmlEncoding) preferredEncodings.push(xmlEncoding);

  for (const encoding of preferredEncodings) {
    const decoded = decodeBuffer(buffer, encoding);
    if (decoded && !hasReplacementChars(decoded)) {
      return decodeIso6937(decoded);
    }
  }

  const utf8Decoded = decodeBuffer(buffer, DEFAULT_TEXT_ENCODING);
  if (utf8Decoded && !hasReplacementChars(utf8Decoded)) {
    return decodeIso6937(utf8Decoded);
  }

  for (const encoding of CENTRAL_EUROPEAN_ENCODINGS) {
    const decoded = decodeBuffer(buffer, encoding);
    if (decoded) {
      return decodeIso6937(decoded);
    }
  }

  return decodeIso6937(buffer.toString(DEFAULT_TEXT_ENCODING));
}


module.exports = { decodeEnigma2Response };
