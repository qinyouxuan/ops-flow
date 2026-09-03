// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMysqlBitRows } from '../src/main/database/mysqlBitValueNormalizer.mjs'

test('normalizes MySQL BIT(1) buffers to 0 and 1', () => {
  const fields = [{ name: 'disabled', columnType: 16, columnLength: 1 }]
  const rows = normalizeMysqlBitRows([
    { disabled: Buffer.from([0]) },
    { disabled: Buffer.from([1]) },
    { disabled: null }
  ], fields)

  assert.deepEqual(rows, [{ disabled: 0 }, { disabled: 1 }, { disabled: null }])
})

test('normalizes wider BIT values without losing integer precision', () => {
  const rows = normalizeMysqlBitRows([
    { flags: Uint8Array.from([0xa5]), largeFlags: Buffer.from('ffffffffffffffff', 'hex') }
  ], [
    { name: 'flags', type: 'BIT', length: 8 },
    { name: 'largeFlags', type: 16, length: 64 }
  ])

  assert.deepEqual(rows, [{ flags: 165, largeFlags: '18446744073709551615' }])
})

test('does not reinterpret non-BIT binary columns', () => {
  const payload = Buffer.from([0, 1])
  const row = { payload }
  const rows = normalizeMysqlBitRows([row], [{ name: 'payload', columnType: 252, columnLength: 2 }])

  assert.equal(rows[0], row)
  assert.equal(rows[0].payload, payload)
})
