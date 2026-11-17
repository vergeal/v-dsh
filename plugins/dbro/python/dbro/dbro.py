#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
只读 SQL 查询入口（达梦 8 / MySQL / PostgreSQL / Oracle / SQL Server / SQLite）。

查库一律走这里，不要直接调 *_exec.py：那些执行器留了写入口，本脚本**没有任何写开关**。
Redis 走 dbro_kv.py，Elasticsearch 走 dbro_search.py——它们不是 SQL，白名单不一样。

三层防护：
1. 白名单：只放行单条 select / show / desc / describe / explain；
2. 语句体内禁止 select ... into、for update / for share / lock in share mode、
   nextval() / setval() 这类会改数据的写法；
3. 底层执行器再开只读保护（MySQL / PostgreSQL / 达梦 / Oracle 用只读事务，SQL Server
   用 BEGIN TRAN + ROLLBACK，SQLite 用 `mode=ro` 打开文件），结束一律 rollback。
   即使白名单漏判，库也会拒绝写。

用法：
    dbro.py dm        -e "select * from v$instance"
    dbro.py mysql     -d im -e "show tables" -H 10.199.10.15 -u readonly
    dbro.py sqlite    -d /var/lib/app/app.db -e "select name from sqlite_master"
    dbro.py oracle    -d ORCLPDB1 -e "select * from user_tables"

连接信息优先命令行，其次环境变量（DM8_* / MYSQL_* / PG* / ORACLE_* / MSSQL_*），与执行器一致。
口令不要写在命令行里，用环境变量或 --password-stdin。
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent

SQL_DIALECTS = ("dm", "mysql", "pg", "oracle", "mssql", "sqlite")

# 只有 SQLite 不带 host / port / user：它的 -d 是文件路径。
FILE_DIALECTS = ("sqlite",)

# 这几类要么没有可默认的库名，要么库名错了就连不上。
DATABASE_REQUIRED = ("mysql", "oracle", "mssql", "sqlite")

# 语句只允许以这些词开头（小写比较）
ALLOWED_FIRST = ("select", "show", "desc", "describe", "explain")

# 出现在白名单语句内部、但会产生写入/副作用的关键词
FORBIDDEN = re.compile(
    r"\binto\b"
    r"|\bfor\s+update\b"
    r"|\bfor\s+share\b"
    r"|\block\s+in\s+share\s+mode\b"
    r"|\bnextval\s*\("
    r"|\bsetval\s*\("
    r"|\bpg_(?:terminate|cancel)_backend\b"
    r"|\bdblink_exec\b"
    r"|\blo_(?:import|export|unlink|create)\b",
    re.I,
)
MAX_TIMEOUT = 120.0


def strip_comments(sql):
    """去掉 -- 行注释与 /* */ 块注释，便于取首词。"""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    sql = re.sub(r"--[^\n]*", " ", sql)
    return sql


def split_statements(sql):
    """按分号拆分（忽略字符串字面量里的分号）。"""
    out, buf, quote = [], [], None
    for ch in sql:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"', "`"):
            quote = ch
        elif ch == ";":
            out.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    out.append("".join(buf))
    return [s for s in out if strip_comments(s).strip()]


def check(sql):
    """校验 SQL 是否可执行；通过返回校验后的文本，否则抛 ValueError。"""
    statements = split_statements(sql)
    if not statements:
        raise ValueError("没有 SQL。")
    if len(statements) > 1:
        raise ValueError("只允许单条查询，检测到 %d 条语句。" % len(statements))
    stmt = statements[0]
    cleaned = strip_comments(stmt).strip()
    first = re.match(r"[A-Za-z]+", cleaned)
    if not first or first.group(0).lower() not in ALLOWED_FIRST:
        raise ValueError("只允许 select/show/desc/describe/explain，收到：%s"
                         % cleaned[:40])
    hit = FORBIDDEN.search(cleaned)
    if hit:
        raise ValueError("语句包含只读入口禁止的写法：%s" % hit.group(0))
    return stmt.strip().rstrip(";")


def build(dialect, ns, sql):
    """拼出对应执行器命令。只传 --read-only，永不传 --force/--allow-write。"""
    tool = {"dm": "dm8_exec.py", "mysql": "mysql_exec.py", "pg": "pgsql_exec.py",
            "oracle": "oracle_exec.py", "mssql": "mssql_exec.py",
            "sqlite": "sqlite_exec.py"}[dialect]
    cmd = [sys.executable, str(TOOLS / tool), "-e", sql]
    # pg 执行器默认只读，用 --allow-write 反向开启；另外几个要显式 --read-only。
    if dialect != "pg":
        cmd.insert(2, "--read-only")

    if dialect in FILE_DIALECTS:
        # SQLite 只认文件路径，没有 host / port / user 可传。
        cmd += ["-d", ns.database]
    else:
        if dialect in DATABASE_REQUIRED and not ns.database:
            raise ValueError("%s 需要 -d 指定库名 / 服务名。" % dialect)
        cmd += ["-H", ns.host, "-P", str(ns.port), "-u", ns.user]
        if ns.database:
            cmd += ["-d", ns.database]

    cmd += ["--timeout", str(ns.timeout), "--max-rows", str(ns.max_rows)]
    return cmd


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="只读查询 SQL 数据库（单条 select 类语句，无写开关）。")
    parser.add_argument("dialect", choices=SQL_DIALECTS, help="库类型")
    parser.add_argument("-e", "--sql", help="SQL 字符串")
    parser.add_argument("-f", "--file", help="从文件读 SQL")
    parser.add_argument("-H", "--host")
    parser.add_argument("-P", "--port", type=int)
    parser.add_argument("-u", "--user")
    parser.add_argument("-p", "--password", help="不推荐：口令会留在 shell 历史")
    parser.add_argument("--password-stdin", action="store_true",
                        help="从标准输入读口令（推荐）")
    parser.add_argument("-d", "--database", help="库名 / 服务名 / 达梦 schema / SQLite 文件路径")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-rows", type=int, default=200,
                        help="最多显示行数，默认 200")
    return parser.parse_args(argv)


DEFAULTS = {
    "dm": {"host": "DM8_HOST", "port": ("DM8_PORT", 5236), "user": ("DM8_USER", "SYSDBA"),
           "password": ("DM8_PASSWORD", "SYSDBA")},
    "mysql": {"host": "MYSQL_HOST", "port": ("MYSQL_PORT", 3306), "user": ("MYSQL_USER", "root"),
              "password": ("MYSQL_PASSWORD", "")},
    "pg": {"host": "PGHOST", "port": ("PGPORT", 5432), "user": ("PGUSER", "postgres"),
           "password": ("PGPASSWORD", "")},
    "oracle": {"host": "ORACLE_HOST", "port": ("ORACLE_PORT", 1521), "user": ("ORACLE_USER", "system"),
               "password": ("ORACLE_PASSWORD", "")},
    "mssql": {"host": "MSSQL_HOST", "port": ("MSSQL_PORT", 1433), "user": ("MSSQL_USER", "sa"),
              "password": ("MSSQL_PASSWORD", "")},
    # SQLite 打开的是文件，没有连接口令；mode=ro 就是它的只读保护。
    "sqlite": {"host": None, "port": None, "user": None, "password": None},
}


def fill_defaults(ns):
    spec = DEFAULTS[ns.dialect]
    if not ns.host:
        ns.host = os.environ.get(spec["host"], "127.0.0.1") if spec["host"] else ""
    if ns.port is None:
        ns.port = int(os.environ.get(spec["port"][0], spec["port"][1])) if spec["port"] else 0
    if not ns.user:
        ns.user = os.environ.get(spec["user"][0], spec["user"][1]) if spec["user"] else ""
    if ns.password_stdin:
        ns.password = sys.stdin.readline().rstrip("\n")
    elif ns.password is None:
        ns.password = os.environ.get(spec["password"][0], spec["password"][1]) if spec["password"] else ""
    ns.timeout = min(max(ns.timeout, 1.0), MAX_TIMEOUT)
    return ns


def main(argv=None):
    ns = fill_defaults(parse_args(argv))

    if ns.file:
        with open(ns.file, encoding="utf-8") as fh:
            raw = fh.read()
    elif ns.sql:
        raw = ns.sql
    elif not sys.stdin.isatty():
        raw = sys.stdin.read()
    else:
        print("没有 SQL：用 -e / -f / 管道传入。", file=sys.stderr)
        return 2

    try:
        sql = check(raw)
        cmd = build(ns.dialect, ns, sql)
    except ValueError as exc:
        print("拒绝执行：%s" % exc, file=sys.stderr)
        return 3

    # 口令走环境变量，不放在 argv 里（避免 ps / 进程列表泄露）。
    env = dict(os.environ)
    password_spec = DEFAULTS[ns.dialect]["password"]
    if password_spec:
        env[password_spec[0]] = ns.password or ""
    proc = subprocess.run(cmd, env=env)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
