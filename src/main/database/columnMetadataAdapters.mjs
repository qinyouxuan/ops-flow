// SPDX-License-Identifier: MPL-2.0

const mysqlColumnMetadataAdapter = async ({ connection, table }) => {
  const [rows] = await connection.query(
    `
      select
        column_name,
        column_type as data_type,
        is_nullable,
        column_default,
        column_comment
      from information_schema.columns
      where table_schema = ? and table_name = ?
      order by ordinal_position
    `,
    [table.schema, table.name]
  )
  return rows
}

const oracleLikeColumnMetadataAdapter = async ({ connection, config, table, executeOracleLike }) => {
  const result = await executeOracleLike(
    connection,
    config.engine,
    `
      select
        column_info.COLUMN_NAME as column_name,
        column_info.DATA_TYPE as data_type,
        column_info.NULLABLE as is_nullable,
        column_info.DATA_DEFAULT as column_default,
        comment_info.COMMENTS as column_comment
      from ALL_TAB_COLUMNS column_info
      left join ALL_COL_COMMENTS comment_info
        on comment_info.OWNER = column_info.OWNER
        and comment_info.TABLE_NAME = column_info.TABLE_NAME
        and comment_info.COLUMN_NAME = column_info.COLUMN_NAME
      where column_info.OWNER = :schema and column_info.TABLE_NAME = :name
      order by column_info.COLUMN_ID
    `,
    { schema: table.schema, name: table.name }
  )
  return result.rows
}

const columnMetadataAdapters = Object.freeze({
  postgres: async ({ connection, table }) => {
    const result = await connection.query(
      `
        select
          column_info.column_name,
          column_info.data_type,
          column_info.is_nullable,
          column_info.column_default,
          col_description(relations.oid, attributes.attnum) as column_comment
        from information_schema.columns column_info
        left join pg_catalog.pg_namespace namespaces
          on namespaces.nspname = column_info.table_schema
        left join pg_catalog.pg_class relations
          on relations.relnamespace = namespaces.oid
          and relations.relname = column_info.table_name
        left join pg_catalog.pg_attribute attributes
          on attributes.attrelid = relations.oid
          and attributes.attname = column_info.column_name
          and attributes.attnum > 0
          and not attributes.attisdropped
        where column_info.table_schema = $1 and column_info.table_name = $2
        order by column_info.ordinal_position
      `,
      [table.schema, table.name]
    )
    return result.rows
  },
  sqlserver: async ({ connection, table, mssql }) => {
    const request = connection.request()
    request.input('schema', mssql.NVarChar, table.schema)
    request.input('name', mssql.NVarChar, table.name)
    const result = await request.query(`
      select
        info.COLUMN_NAME as column_name,
        info.DATA_TYPE as data_type,
        info.IS_NULLABLE as is_nullable,
        info.COLUMN_DEFAULT as column_default,
        convert(nvarchar(4000), properties.value) as column_comment
      from INFORMATION_SCHEMA.COLUMNS info
      inner join sys.schemas schemas
        on schemas.name = info.TABLE_SCHEMA
      inner join sys.objects objects
        on objects.schema_id = schemas.schema_id
        and objects.name = info.TABLE_NAME
        and objects.type in ('U', 'V')
      inner join sys.columns column_info
        on column_info.object_id = objects.object_id
        and column_info.name = info.COLUMN_NAME
      left join sys.extended_properties properties
        on properties.class = 1
        and properties.major_id = objects.object_id
        and properties.minor_id = column_info.column_id
        and properties.name = N'MS_Description'
      where info.TABLE_SCHEMA = @schema and info.TABLE_NAME = @name
      order by info.ORDINAL_POSITION
    `)
    return result.recordset
  },
  oracle: oracleLikeColumnMetadataAdapter,
  dm: oracleLikeColumnMetadataAdapter,
  mysql: mysqlColumnMetadataAdapter,
  mariadb: mysqlColumnMetadataAdapter
})

function quoteIdentifier(engine, value) {
  const identifier = String(value || '')
  if (['postgres', 'oracle', 'dm'].includes(engine)) return `"${identifier.replace(/"/g, '""')}"`
  if (engine === 'sqlserver') return `[${identifier.replace(/]/g, ']]')}]`
  return `\`${identifier.replace(/`/g, '``')}\``
}

function qualifiedColumnName(engine, table, columnName) {
  return [table.schema, table.name, columnName]
    .filter((part) => part && part !== '-')
    .map((part) => quoteIdentifier(engine, part))
    .join('.')
}

function quoteCommentLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

const mysqlColumnCommentAdapter = async ({ connection, config, table, column }) => {
  const engine = String(config.engine || '').toLowerCase()
  const tableName = [table.schema, table.name]
    .filter((part) => part && part !== '-')
    .map((part) => quoteIdentifier(engine, part))
    .join('.')
  const definition = [
    quoteIdentifier(engine, column.name),
    String(column.type || '').trim(),
    column.nullable ? 'NULL' : 'NOT NULL',
    String(column.defaultValue ?? '').trim() ? `DEFAULT ${String(column.defaultValue).trim()}` : '',
    `COMMENT ${quoteCommentLiteral(column.comment)}`
  ].filter(Boolean).join(' ')
  await connection.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${definition}`)
}

const oracleLikeColumnCommentAdapter = async ({ connection, config, table, column, executeOracleLike }) => {
  const engine = String(config.engine || '').toLowerCase()
  const target = qualifiedColumnName(engine, table, column.name)
  await executeOracleLike(
    connection,
    config.engine,
    `COMMENT ON COLUMN ${target} IS ${quoteCommentLiteral(column.comment)}`,
    [],
    { autoCommit: true }
  )
}

const columnCommentAdapters = Object.freeze({
  postgres: async ({ connection, table, column }) => {
    const target = qualifiedColumnName('postgres', table, column.name)
    const comment = String(column.comment || '').trim()
    await connection.query(`COMMENT ON COLUMN ${target} IS ${comment ? quoteCommentLiteral(comment) : 'NULL'}`)
  },
  sqlserver: async ({ connection, table, column, mssql }) => {
    const existsRequest = connection.request()
    existsRequest.input('schema', mssql.NVarChar, table.schema)
    existsRequest.input('table', mssql.NVarChar, table.name)
    existsRequest.input('column', mssql.NVarChar, column.name)
    const existing = await existsRequest.query(`
      select case when exists (
        select 1
        from sys.extended_properties properties
        inner join sys.objects objects on objects.object_id = properties.major_id
        inner join sys.schemas schemas on schemas.schema_id = objects.schema_id
        inner join sys.columns column_info
          on column_info.object_id = objects.object_id
          and column_info.column_id = properties.minor_id
        where properties.class = 1
          and properties.name = N'MS_Description'
          and schemas.name = @schema
          and objects.name = @table
          and column_info.name = @column
      ) then 1 else 0 end as property_exists
    `)
    const propertyExists = Boolean(existing.recordset?.[0]?.property_exists)
    const comment = String(column.comment || '').trim()
    if (!comment && !propertyExists) return
    const request = connection.request()
    request.input('schema', mssql.NVarChar, table.schema)
    request.input('table', mssql.NVarChar, table.name)
    request.input('column', mssql.NVarChar, column.name)
    if (comment) request.input('comment', mssql.NVarChar, comment)
    const procedure = propertyExists
      ? comment ? 'sp_updateextendedproperty' : 'sp_dropextendedproperty'
      : 'sp_addextendedproperty'
    const valueArgument = comment ? ', @value = @comment' : ''
    await request.query(`
      EXEC sys.${procedure}
        @name = N'MS_Description'${valueArgument},
        @level0type = N'SCHEMA', @level0name = @schema,
        @level1type = N'TABLE', @level1name = @table,
        @level2type = N'COLUMN', @level2name = @column
    `)
  },
  oracle: oracleLikeColumnCommentAdapter,
  dm: oracleLikeColumnCommentAdapter,
  mysql: mysqlColumnCommentAdapter,
  mariadb: mysqlColumnCommentAdapter
})

function readMetadataValue(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row || {}, key)) return row[key]
  }
  return undefined
}

function normalizeColumnMetadata(rows = []) {
  return rows.map((row) => ({
    name: readMetadataValue(row, 'column_name', 'COLUMN_NAME', 'name') || '-',
    type: readMetadataValue(row, 'data_type', 'DATA_TYPE', 'column_type', 'COLUMN_TYPE', 'type') || '-',
    nullable: readMetadataValue(row, 'is_nullable', 'IS_NULLABLE', 'nullable') || '-',
    defaultValue: readMetadataValue(row, 'column_default', 'COLUMN_DEFAULT', 'defaultValue') ?? '-',
    comment: readMetadataValue(row, 'column_comment', 'COLUMN_COMMENT', 'comments', 'COMMENTS', 'comment') || '-'
  }))
}

export async function inspectDatabaseColumnMetadata(context) {
  const engine = String(context.config?.engine || '').toLowerCase()
  const adapter = columnMetadataAdapters[engine] || mysqlColumnMetadataAdapter
  const rows = await adapter(context)
  return normalizeColumnMetadata(rows)
}

export async function setDatabaseColumnComment(context) {
  const engine = String(context.config?.engine || '').toLowerCase()
  const adapter = columnCommentAdapters[engine]
  if (!adapter) throw new Error(`Column comments are not supported for database engine: ${engine || 'unknown'}`)
  await adapter(context)
  return { ok: true }
}
