#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SQLite 语句执行工具（标准库 sqlite3，无第三方驱动）

连接参数：
    -d/--database  SQLITE_DATABASE  数据库文件路径，必填

SQL 来源（三选一）：
    -f/--file 指定 .sql 文件
    -e/--sql  直接给 SQL 字符串
    位置参数   直接给 SQL 字符串；未提供时读 stdin

安全说明：
    文件以 URI `mode=ro` 打开，SQLite 引擎本身拒绝任何写入和 schema 变更，
    连 vacuum、attach 写目标都做不到；这是引擎级只读，比事务回滚更强。
    `:memory:` 被拒绝：每次查询都是新进程，内存库永远是空的，结果只会误导。
    文件不存在时同样拒绝，因为 SQLite 会在写模式下凭空建库。
"""

import argparse
import os
import re
import sqlite3
import sys

DANGEROUS_KEYWORDS = (
    "insert", "update", "delete", "drop", "truncate", "alter", "create",
    "rename", "attach", "detach", "reindex", "vacuum", "analyze", "pragma",
    "begin", "commit", "rollback", "savepoint", "release",
)

READ_ONLY_FIRST = ("select", "show", "desc", "describe", "explain")
READ_ONLY_FORBIDDEN = re.compile(
    r"\binto\b"
    r"|\bfor\s+update\b"
    r"|\bnextval\s*\("
    r"|\bsetval\s*\("
    r"|\battach\b"
    r"|\bdetach\b",
    re.I,
)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="执行 SQLite 语句（标准库 sqlite3），查询输出文本表格。默认只读。"
    )
    parser.add_argument("-H", "--host", default="", help="SQLite 忽略此参数")
    parser.add_argument("-P", "--port", type=int, default=0, help="SQLite 忽略此参数")
    parser.add_argument("-u", "--user", default="", help="SQLite 忽略此参数")
    parser.add_argument("-p", "--password", default="", help="SQLite 忽略此参数")
    parser.add_argument("-d", "--database", default=os.environ.get("SQLITE_DATABASE", ""),
                        help="数据库文件路径")
    parser.add_argument("-f", "--file", help="要执行的 .sql 文件路径")
    parser.add_argument("-e", "--sql", dest="sql_text", help="直接执行的 SQL 字符串")
    parser.add_argument("--dry-run", action="store_true", help="只打印 SQL，不打开数据库")
    parser.add_argument("--force", action="store_true", help="跳过破坏性语句的拦截")
    parser.add_argument("--read-only", action="store_true",
                        help="只读模式：只允许查询语句（文件本身也以 mode=ro 打开）")
    parser.add_argument("--timeout", type=float, default=30.0,
                        help="忙等待超时（秒），默认 30")
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
    in_single = in_double = in_backtick = False
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
        if not in_single and not in_double and not in_backtick:
            if ch == "-" and nxt == "-":
                in_line = True
                i += 1
                continue
            if ch == "/" and nxt == "*":
                in_block = True
                i += 2
                continue
        if ch == "'" and not in_double and not in_backtick:
            in_single = not in_single
        elif ch == '"' and not in_single and not in_backtick:
            in_double = not in_double
        elif ch == "`" and not in_single and not in_double:
            in_backtick = not in_backtick
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


def resolve_path(database):
    """校验 SQLite 文件路径；返回绝对路径，不可用时抛 ValueError。"""
    if not database:
        raise ValueError("SQLite 需要 -d 指定数据库文件路径。")
    if database.startswith(":"):
        raise ValueError("不支持 %s：每次查询都是新进程，内存库永远是空的。" % database)
    if database.startswith("file:"):
        raise ValueError("请只传文件路径，不要自己拼 file: URI（只读参数由本工具负责）。")
    path = os.path.abspath(os.path.expanduser(database))
    if not os.path.exists(path):
        raise ValueError("数据库文件不存在：%s（只读模式不会凭空建库）。" % path)
    if not os.path.isfile(path):
        raise ValueError("不是一个文件：%s" % path)
    return path


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
        path = resolve_path(args.database)
    except ValueError as exc:
        print("拒绝执行：%s" % exc, file=sys.stderr)
        return 3

    try:
        conn = sqlite3.connect("file:%s?mode=ro" % path.replace("\\", "/"), uri=True,
                               timeout=max(1.0, args.timeout))
    except sqlite3.Error as exc:
        print("打开 SQLite 失败：%s" % exc, file=sys.stderr)
        return 1

    try:
        conn.text_factory = str
        cur = conn.cursor()
        try:
            cur.execute(statement)
        except sqlite3.Error as exc:
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
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
