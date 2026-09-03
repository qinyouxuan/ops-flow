// SPDX-License-Identifier: MPL-2.0

const MYSQL_TYPE_BIT = 16

function isMysqlBitField(field) {
  const type = field?.columnType ?? field?.type
  return type === MYSQL_TYPE_BIT || String(type || '').toUpperCase() === 'BIT'
}

function decodeMysqlBitValue(value, bitLength) {
  if (value === null || value === undefined) return value
  if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) return value

  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  let decoded = 0n
  for (const byte of bytes) decoded = (decoded << 8n) | BigInt(byte)

  return bitLength <= 53 ? Number(decoded) : decoded.toString()
}

export function normalizeMysqlBitRows(rows, fields) {
  if (!Array.isArray(rows) || !Array.isArray(fields)) return rows
  const bitFields = fields
    .filter(isMysqlBitField)
    .map((field) => ({
      name: field.name,
      bitLength: Math.max(1, Number(field.columnLength ?? field.length) || 1)
    }))
    .filter((field) => field.name)
  if (!bitFields.length) return rows

  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    let normalizedRow = row
    for (const field of bitFields) {
      if (!Object.prototype.hasOwnProperty.call(row, field.name)) continue
      const normalizedValue = decodeMysqlBitValue(row[field.name], field.bitLength)
      if (normalizedValue === row[field.name]) continue
      if (normalizedRow === row) normalizedRow = { ...row }
      normalizedRow[field.name] = normalizedValue
    }
    return normalizedRow
  })
}
