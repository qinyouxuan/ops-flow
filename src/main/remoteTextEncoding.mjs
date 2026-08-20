// SPDX-License-Identifier: MPL-2.0

import iconv from 'iconv-lite'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff])

function startsWithBytes(buffer, prefix) {
  return buffer.length >= prefix.length && prefix.every((byte, index) => buffer[index] === byte)
}

function detectLineEnding(content) {
  const crlf = (content.match(/\r\n/g) || []).length
  const withoutCrlf = content.replace(/\r\n/g, '')
  const lf = (withoutCrlf.match(/\n/g) || []).length
  const cr = (withoutCrlf.match(/\r/g) || []).length
  if (crlf >= lf && crlf >= cr && crlf > 0) return 'crlf'
  if (cr > lf && cr > 0) return 'cr'
  return 'lf'
}

function decodedResult(content, encoding) {
  return {
    content,
    encoding,
    lineEnding: detectLineEnding(content)
  }
}

export function decodeRemoteTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Remote text content must be a Buffer.')
  if (startsWithBytes(buffer, UTF8_BOM)) {
    return decodedResult(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(3)), 'utf8-bom')
  }
  if (startsWithBytes(buffer, UTF16_LE_BOM)) {
    return decodedResult(new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2)), 'utf16le')
  }
  if (startsWithBytes(buffer, UTF16_BE_BOM)) {
    return decodedResult(new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2)), 'utf16be')
  }
  if (buffer.includes(0)) throw new Error('Binary file preview is not supported.')

  try {
    return decodedResult(new TextDecoder('utf-8', { fatal: true }).decode(buffer), 'utf8')
  } catch {
    try {
      return decodedResult(new TextDecoder('gb18030', { fatal: true }).decode(buffer), 'gb18030')
    } catch {
      throw new Error('The file encoding is not supported. Use UTF-8, UTF-16, GBK, or GB18030.')
    }
  }
}

function normalizeLineEndings(content, lineEnding) {
  const separator = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : '\n'
  return String(content || '').replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, separator)
}

export function encodeRemoteTextContent(content, options = {}) {
  const encoding = String(options.encoding || 'utf8').toLowerCase()
  const normalized = normalizeLineEndings(content, options.lineEnding)
  if (encoding === 'utf8') return { buffer: Buffer.from(normalized, 'utf8'), encoding }
  if (encoding === 'utf8-bom') {
    return { buffer: Buffer.concat([UTF8_BOM, Buffer.from(normalized, 'utf8')]), encoding }
  }
  if (encoding === 'utf16le') {
    return { buffer: Buffer.concat([UTF16_LE_BOM, Buffer.from(normalized, 'utf16le')]), encoding }
  }
  if (encoding === 'utf16be') {
    return { buffer: Buffer.concat([UTF16_BE_BOM, iconv.encode(normalized, 'utf16-be')]), encoding }
  }
  if (encoding === 'gb18030') return { buffer: iconv.encode(normalized, 'gb18030'), encoding }
  throw new Error(`Unsupported text encoding: ${encoding}`)
}
