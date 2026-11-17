#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SQL Server 语句执行工具（优先 pymssql，退回 pyodbc）

连接参数优先取命令行参数，其次读环境变量，最后用默认值：
    -H/--host      MSSQL_HOST      默认 127.0.0.1
    -P/--port      MSSQL_PORT      默认 1433
    -u/--user      MSSQL_USER      默认 sa
    -p/--password  MSSQL_PASSWORD  默认空
    -d/--database  MSSQL_DATABASE  默认空（数据库名，不是 schema）
    --driver       MSSQL_DRIVER    pyodbc 的 ODBC 驱动名，默认 `ODBC Driver 18 for SQL Server`

SQL 来源（三选一）：
    -f/--file 指定 .sql 文件
    -e/--sql  直接给 SQL 字符串
    位置参数   直接给 SQL 字符串；未提供时读 stdin

安全说明：
    T-SQL 没有只读事务，所以只读模式把语句包在 BEGIN TRAN / ROLLBACK 里：
    白名单漏判的写入会在回滚时一起丢掉，数据库不留痕迹。
    注意 T-SQL 没有 show / desc 语句，表结构请走 dbro_columns 生成的 information_schema 查询。
    pyodbc 走 ODBC Driver 18 时默认强制加密；证书不可信会直接连接失败，不会静默降级。
"""

import argparse
import os
import re
import sys

DANGEROUS_KEYWORDS = (
    "insert", "update", "delete", "merge", "drop", "truncate", "alter", "create",
    "rename", "grant", "revoke", "exec", "execute", "backup", "restore", "shutdown",
    "kill", "dbcc",
)

READ_ONLY_FIRST = ("select", "show", "desc", "describe", "explain", "with")
READ_ONLY_FORBIDDEN = re.compile(
    r"\binto\b"
    r"|\bfor\s+update\b"
    r"|\bnextval\s*\("
    r"|\bsetval\s*\(",
    re.I,
)
# WITH 允许，但 `WITH x AS (DELETE ...)` 这类数据修改 CTE 仍然要拦住。
MODIFYING_CTE = re.compile(r"\b(insert|update|delete|merge)\b", re.I)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="执行 SQL Server 语句（pymssql 或 pyodbc），查询输出文本表格。"
    )
    parser.add_argument("-H", "--host", default=os.environ.get("MSSQL_HOST", "127.0.0.1"))
    parser.add_argument("-P", "--port", type=int, default=int(os.environ.get("MSSQL_PORT", "1433")))
    parser.add_argument("-u", "--user", default=os.environ.get("MSSQL_USER", "sa"))
    parser.add_argument("-p", "--password", default=os.environ.get("MSSQL_PASSWORD", ""))
    parser.add_argument("-d", "--database", default=os.environ.get("MSSQL_DATABASE", ""))
    parser.add_argument("--driver", default=os.environ.get("MSSQL_DRIVER", "ODBC Driver 18 for SQL Server"),
                        help="仅 pyodbc 用到")
    parser.add_argument("-f", "--file", help="要执行的 .sql 文件路径")
    parser.add_argument("-e", "--sql", dest="sql_text", help="直接执行的 SQL 字符串")
    parser.add_argument("--dry-run", action="store_true", help="只打印 SQL，不连接数据库")
    parser.add_argument("--force", action="store_true", help="跳过破坏性语句的拦截")
    parser.add_argument("--read-only", action="store_true",
                        help="只读模式：只允许查询语句，包在 BEGIN TRAN / ROLLBACK 里执行")
    parser.add_argument("--timeout", type=float, default=30.0, help="连接与查询超时（秒），默认 30")
    parser.add_argument("--max-rows", type=int, default=200, help="最多显示行数，默认 200")
    parser.add_argument("sql", nargs="*", help="SQL 字符串（未提供时读 stdin）")
    return parser.parse_args(argv)


def read_sql(args):
    if args.file:
        with open(args.file, "r", encoding="utf-8") as fh:
            return fh.read()
    if args.sql_text:
        return args.sql_text
    if args.sql:
        return " ".join(args.sql)
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


def strip_comments(statement):
    out = []
    i, n = 0, len(statement)
    in_single = in_double = in_bracket = False
    in_line = in_block = False
    while i < n:
        ch = statement[i]
        nxt = statement[i + 1] if i + 1 < n else ""
        if in_line:
            if ch == "\n":
                in_line = False
            i += 1
            continue
        if in_block:
            if ch == "*" and nxt == "/":
                in_block = False
                i += 2
                continue
            i += 1
            continue
        if not in_single and not in_double and not in_bracket:
            if ch == "-" and nxt == "-":
                in_line = True
                i += 1
                continue
            if ch == "/" and nxt == "*":
                in_block = True
                i += 2
                continue
        if ch == "'" and not in_double and not in_bracket:
            in_single = not in_single
        elif ch == '"' and not in_single and not in_bracket:
            in_double = not in_double
        elif ch == "[" and not in_single and not in_double:
            in_bracket = True
        elif ch == "]" and in_bracket:
            in_bracket = False
        out.append(ch)
        i += 1
    return "".join(out)


def first_word(statement):
    cleaned = strip_comments(statement).strip()
    match = re.match(r"[A-Za-z_]+", cleaned)
    return (match.group(0).lower() if match else ""), cleaned


def readonly_reason(statement):
    """--read-only 下的白名单校验；返回拒绝原因，通过则返回 None。"""
    first, cleaned = first_word(statement)
    if first not in READ_ONLY_FIRST:
        return "只允许 select/with/show/desc/describe/explain，收到 %s" % cleaned[:30]
    hit = READ_ONLY_FORBIDDEN.search(cleaned)
    if hit:
        return "不允许的写法 %s" % hit.group(0)
    if first == "with" and MODIFYING_CTE.search(cleaned):
        return "只读 CTE 之外的数据修改语句被拒绝"
    return None


def is_dangerous(statement):
    first, _ = first_word(statement)
    return first in DANGEROUS_KEYWORDS


def render_table(headers, rows):
    headers = [str(h) if h is not None else "NULL" for h in headers]
    rows = [[("" if v is None else str(v)) for v in row] for row in rows]
    widths = [len(h) for h in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))
    line = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    out = [line]
    out.append("| " + " | ".join(h.ljust(widths[i]) for i, h in enumerate(headers)) + " |")
    out.append(line)
    for row in rows:
        out.append("| " + " | ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)) + " |")
    out.append(line)
    out.append("(%d rows)" % len(rows))
    return "\n".join(out)


def connect(args):
    """返回 (connection, 驱动名)；两种驱动都不可用时抛异常。"""
    try:
        import pymssql
    except ImportError:
        pymssql = None
    if pymssql is not None:
        conn = pymssql.connect(
            server=args.host,
            port=str(args.port),
            user=args.user,
            password=args.password,
            database=args.database or None,
            login_timeout=max(1, int(args.timeout)),
            timeout=max(1, int(args.timeout)),
            autocommit=False,
        )
        return conn, "pymssql"

    try:
        import pyodbc
    except ImportError:
        raise RuntimeError(
            "缺少 SQL Server 驱动：pip install pymssql，或装好 ODBC Driver 后 pip install pyodbc。")
    settings = "DRIVER={%s};SERVER=%s,%d;DATABASE=%s;UID=%s;PWD=%s;" % (
        args.driver, args.host, args.port, args.database or "master", args.user, args.password)
    conn = pyodbc.connect(settings, timeout=max(1, int(args.timeout)), autocommit=False)
    return conn, "pyodbc"


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    sql_text = read_sql(args)
    if not sql_text.strip():
        print("未提供 SQL（可用 -f 文件 / -e 字符串 / 管道输入）。", file=sys.stderr)
        return 2

    statement = sql_text.strip().rstrip(";")
    if args.read_only:
        reason = readonly_reason(statement)
        if reason:
            print("拒绝执行（--read-only）：%s" % reason, file=sys.stderr)
            return 3
    elif is_dangerous(statement) and not args.force:
        print("检测到破坏性语句，已拒绝。如需放行请加 --force。", file=sys.stderr)
        return 3

    if args.dry_run:
        print(" ".join(statement.split()))
        return 0

    try:
        conn, driver = connect(args)
    except Exception as exc:
        print("连接 SQL Server 失败：%s" % exc, file=sys.stderr)
        return 1

    try:
        cur = conn.cursor()
        if args.read_only:
            # T-SQL 没有只读事务；开一个事务，最后无条件回滚。
            cur.execute("BEGIN TRANSACTION")
        try:
            cur.execute(statement)
        except Exception as exc:
            print("执行失败：%s" % exc, file=sys.stderr)
            print("语句：%s" % " ".join(statement.split()), file=sys.stderr)
            return 1
        if cur.description is not None:
            headers = [d[0] for d in cur.description]
            rows = cur.fetchmany(max(0, args.max_rows))
            print(render_table(headers, rows))
            if len(rows) == args.max_rows:
                print("注意：结果达到 --max-rows 上限（驱动 %s），可能还有更多行。" % driver, file=sys.stderr)
        else:
            print("OK，影响 %d 行" % cur.rowcount)
    finally:
        try:
            conn.rollback()
        except Exception as exc:
            print("回滚失败（驱动 %s）：%s" % (driver, exc), file=sys.stderr)
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
