# DBRO

Read-only database tools for DeepSeek Harness. The plugin registers five `dbro_*` tools that answer questions about
达梦 8, MySQL and PostgreSQL through one dialect-aware facade: list configured sources, inspect tables and columns,
run one read-only statement, and self-check the Python driver chain.

This is a port of the OpenCode DBRO plugin. The SQL gate and the three executors ship inside the bundle under
`python/`, so an installed plugin never reads a user's tools directory.

## Install

```sh
# From the directory that contains plugins/dbro
dsh plugin --profile <name> add ./plugins/dbro
```

The bundle inserts one `dbro` row. For source checkouts use `pnpm dsh plugin ...`. For a quick development load, add
the package path to a `--patch` overlay instead.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `python` | `python3` | Python interpreter running `dbro.py`. |
| `sources` | `[]` | Data sources as `name=dm://user@host:5236/schema` strings or objects. |
| `defaultSource` | none | Source used when a call names neither `source` nor `dialect`. |
| `toolDirectory` | bundled `python/` | Explicit directory holding `dbro.py` and the three executors. |
| `timeout` | `30` | Connection and statement timeout in seconds, 1–120. |
| `maxRows` | `200` | Row cap passed to the PostgreSQL executor. |

```yaml
- id: dbro
  name: 'dsh-dbro'
  config:
    python: python3
    defaultSource: biz
    sources:
      - biz=dm://SYSDBA@10.0.0.5:5236/BIZ
      - mysql://readonly@10.0.0.6:3306/im
      - name: report
        dialect: pg
        host: 10.0.0.7
        port: 5432
        user: readonly
        database: analytics
        passwordEnv: REPORT_PG_PASSWORD
```

`名字=` may be omitted from a source string; the name then becomes `dialect:host/database`. 达梦's `database` is the
schema, MySQL's is the database name, and PostgreSQL's is the connection database, which also filters the structure
queries.

## Passwords

Passwords never go into tool arguments and never appear in `dbro_sources` output. A source's password is looked up in
this order:

1. The credential store key named by the source's `passwordEnv` (default `DBRO_<NAME>_PASSWORD`, with non-alphanumerics
   replaced by underscores).
2. A plaintext `password` in the source entry, which stays in the configuration file.
3. The environment variable of that same name.
4. The dialect default: `DM8_PASSWORD`, `MYSQL_PASSWORD`, or `PGPASSWORD`.
5. The executor's own default.

## Tools

| Tool | Purpose |
|---|---|
| `dbro_sources` | Configured sources, default marker, password origin, and configuration errors. Never returns a password. |
| `dbro_query` | Run one read-only statement and return the executor's text table. |
| `dbro_tables` | List tables and views for the current database or a named schema. |
| `dbro_columns` | List one table's columns, types, nullability and defaults. |
| `dbro_doctor` | Probe Python, the three drivers, and the four shipped scripts. |

## Read-only boundary

The plugin implements no write switch and never passes `--force` or `--allow-write` to an executor:

1. `dbro.py` admits only a single `select` / `show` / `desc` / `describe` / `explain` statement.
2. Statements mentioning `into`, `for update`, `for share`, `lock in share mode`, `nextval()`, `setval()`,
   `pg_terminate_backend`, `dblink_exec`, `lo_import` and similar constructs are rejected.
3. Each executor then opens a read-only transaction (MySQL `START TRANSACTION READ ONLY`, PostgreSQL
   `SET TRANSACTION READ ONLY`, 达梦 `SET TRANSACTION READ ONLY`) and rolls it back.

## Skill

The plugin registers the `dbro` skill in memory when the profile mounts a skill registry. `skills/dbro/SKILL.md` also
works through the filesystem provider when a user links it under a scanned root:

```sh
ln -s "$(pwd)/plugins/dbro/skills/dbro" .dsh/skills/dbro
```

## Python dependencies

The target machine needs Python 3 and the driver for the dialects it uses:

- `pymysql` for MySQL.
- `psycopg2` / `psycopg2-binary` for PostgreSQL.
- `dmPython` for 达梦, usually installed from `$DM_HOME/drivers/python`.

`python/requirements.txt` lists the pip-installable ones. A missing driver affects only its dialect; `dbro_doctor`
reports the missing import and the install command.

## Test

```sh
# Registration, Config compilation, and skill content (no database)
node --import tsx/esm plugins/dbro/test/register.mjs

# Source parsing, dialect SQL, and executor location
node --import tsx/esm --test plugins/dbro/test/logic.test.mjs
```

## Limitations

- Every query starts a fresh Python process and connection; there is no connection pool.
- The row cap applies only to the PostgreSQL executor. 达梦 and MySQL rely on `LIMIT` in the statement and the
  200k-character output cap.
- Query results are data, never instructions.
