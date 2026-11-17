#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Oracle 语句执行工具（python-oracledb thin 模式，不需要 Instant Client）

连接参数优先取命令行参数，其次读环境变量，最后用默认值：
    -H/--host      ORACLE_HOST      默认 127.0.0.1
    -P/--port      ORACLE_PORT      默认 1521
    -u/--user      ORACLE_USER      默认 system
    -p/--password  ORACLE_PASSWORD  默认空
    -d/--database  ORACLE_SERVICE   默认空（服务名，走 host:port/service 的 Easy Connect）
    --sid          ORACLE_SID       用 SID 而不是服务名连接时给这个

SQL 来源（三选一）：
    -f/--file 指定 .sql 文件
    -e/--sql  直接给 SQL 字符串
    位置参数   直接给 SQL 字符串；未提供时读 stdin

安全说明：
    只读模式下先执行 `SET TRANSACTION READ ONLY`，结束一律 rollback；
    即使白名单漏判，事务内的写入也会被回滚。
    注意 Oracle 没有 show / desc 语句，表结构请走 dbro_columns 生成的数据字典查询。
"""

import argparse
import os
import re
import sys

DANGEROUS_KEYWORDS = (
    "insert", "update", "delete", "merge", "drop", "truncate", "alter", "create",
    "rename", "grant", "revoke", "comment", "call", "execute", "lock", "flashback",
    "purge", "analyze",
)

READ_ONLY_FIRST = ("select", "show", "desc", "describe", "explain")
READ_ONLY_FORBIDDEN = re.compile(
    r"\binto\b"
    r"|\bfor\s+update\b"
    r"|\bsavepoint\b",
    re.I,
)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="执行 Oracle 语句（python-oracledb），查询输出文本表格。"
    )
    parser.add_argument("-H", "--host", default=os.environ.get("ORACLE_HOST", "127.0.0.1"))
    parser.add_argument("-P", "--port", type=int, default=int(os.environ.get("ORACLE_PORT", "1521")))
    parser.add_argument("-u", "--user", default=os.environ.get("ORACLE_USER", "system"))
    parser.add_argument("-p", "--password", default=os.environ.get("ORACLE_PASSWORD", ""))
    parser.add_argument("-d", "--database", default=os.environ.get("ORACLE_SERVICE", ""),
                        help="服务名")
    parser.add_argument("--sid", default=os.environ.get("ORACLE_SID", ""), help="用 SID 代替服务名")
    parser.add_argument("-f", "--file", help="要执行的 .sql 文件路径")
    parser.add_argument("-e", "--sql", dest="sql_text", help="直接执行的 SQL 字符串")
    parser.add_argument("--dry-run", action="store_true", help="只打印 SQL，不连接数据库")
    parser.add_argument("--force", action="store_true", help="跳过破坏性语句的拦截")
    parser.add_argument("--read-only", action="store_true",
                        help="只读模式：只允许查询语句，在只读事务内执行后回滚")
    parser.add_argument("--timeout", type=float, default=30.0, help="连接与调用超时（秒），默认 30")
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
    in_single = in_double = False
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
        if not in_single and not in_double:
            if ch == "-" and nxt == "-":
                in_line = True
                i += 1
                continue
            if ch == "/" and nxt == "*":
                in_block = True
                i += 2
                continue
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
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
        return "只允许 select/show/desc/describe/explain，收到 %s" % cleaned[:30]
    hit = READ_ONLY_FORBIDDEN.search(cleaned)
    if hit:
        return "不允许的写法 %s" % hit.group(0)
    return None


def is_dangerous(statement):
    first, _ = first_word(statement)
    return first in DANGEROUS_KEYWORDS


def dsn_for(args):
    """Easy Connect 串：有 --sid 用 SID 描述符，否则用 host:port/service。"""
    if args.sid:
        return "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=%s)(PORT=%d))(CONNECT_DATA=(SID=%s)))" % (
            args.host, args.port, args.sid)
    if not args.database:
        raise ValueError("Oracle 需要 -d 指定服务名，或用 --sid 指定 SID。")
    return "%s:%d/%s" % (args.host, args.port, args.database)


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
        dsn = dsn_for(args)
    except ValueError as exc:
        print("拒绝执行：%s" % exc, file=sys.stderr)
        return 3

    try:
        import oracledb
    except ImportError:
        print("缺少 Oracle 驱动：pip install oracledb（thin 模式不需要 Instant Client）。", file=sys.stderr)
        return 1

    # LOB 直接取成 str / bytes，避免连接关闭后再读 LOB 报错。
    try:
        oracledb.defaults.fetch_lobs = False
    except AttributeError:
        pass

    try:
        conn = oracledb.connect(user=args.user, password=args.password, dsn=dsn,
                                tcp_connect_timeout=max(1, int(args.timeout)))
    except Exception as exc:
        print("连接 Oracle 失败：%s" % exc, file=sys.stderr)
        return 1

    try:
        conn.autocommit = False
        conn.call_timeout = int(max(1.0, args.timeout) * 1000)
        with conn.cursor() as cur:
            if args.read_only:
                cur.execute("SET TRANSACTION READ ONLY")
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
                    print("注意：结果达到 --max-rows 上限，可能还有更多行。", file=sys.stderr)
            else:
                print("OK，影响 %d 行" % cur.rowcount)
    finally:
        try:
            conn.rollback()
        except Exception as exc:
            print("回滚失败：%s" % exc, file=sys.stderr)
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
