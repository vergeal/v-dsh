#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Elasticsearch 只读查询入口。

和 dbro.py 对 SQL、dbro_kv.py 对 Redis 的角色一样：本脚本**没有任何写开关**。
不要直接调 es_exec.py，那个执行器留着完整的 HTTP 方法。

防护靠“固定操作枚举”，不是靠路径黑名单：只有 `OPS` 里列出的操作能执行，每个操作
绑定一个固定的 HTTP 方法和一条固定的 URL 模板，索引名再过一遍字符白名单。写操作
（index / update / delete / _bulk / _reindex / _delete_by_query / _update_by_query /
ingest / snapshot / _cat 的写变体）根本不在这个枚举里，拼不出来就发不出去。

另外：
- 查询体里的 `script` / `script_fields` / `runtime_mappings` 会执行 Painless 代码，
  统一拒绝——静态判断不了脚本干了什么。
- 索引名不允许 `/`、`\\`、`..` 和开头的 `_`，防止越到别的 API 路径或系统索引。
- 只做 GET / POST 到只读端点；POST 是 `_search` / `_count` 的常规写法，端点本身不改数据。

兜底仍然是账号：给数据源配一个只有 `read` / `view_index_metadata`  privileges 的用户。

用法：
    dbro_search.py indices
    dbro_search.py search -i logs-* --body '{"query":{"match_all":{}},"size":5}'
    dbro_search.py mapping -i logs-app
    dbro_search.py health
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
MAX_TIMEOUT = 120.0

# 操作 -> (HTTP 方法, 路径模板, 是否需要索引, 是否需要请求体)
OPS = {
    "indices": ("GET", "/_cat/indices/%s?format=json&v&s=index", True, False),
    "mapping": ("GET", "/%s/_mapping", True, False),
    "settings": ("GET", "/%s/_settings", True, False),
    "search": ("POST", "/%s/_search", True, True),
    "count": ("POST", "/%s/_count", True, True),
    "resolve": ("GET", "/_resolve/index/%s", True, False),
    "health": ("GET", "/_cluster/health", False, False),
    "allocation": ("GET", "/_cat/allocation?format=json&v", False, False),
    "nodes": ("GET", "/_nodes/stats?filter_path=**.mem,**.fs,**.indices", False, False),
    "templates": ("GET", "/_index_template", False, False),
}

# 会执行脚本或改数据的查询体字段
FORBIDDEN_BODY_KEYS = {
    "script", "script_fields", "runtime_mappings", "script_score",
    "delete", "dest", "source", "conflicts", "scroll",
}

INDEX_PATTERN = re.compile(r"^[A-Za-z0-9_\-.*,]{1,256}$")
MAX_BODY = 100_000


def check_index(index):
    """校验索引名 / 模式；返回可用值，不通过抛 ValueError。"""
    value = (index or "").strip()
    if not value:
        raise ValueError("这个操作需要 -i 指定索引名或模式，例如 logs-*。")
    if not INDEX_PATTERN.match(value):
        raise ValueError("索引名只能包含字母、数字、_ - . * 和逗号分隔的多个模式，"
                         "且不能含 / \\ 或空格，收到：%s" % value)
    for part in value.split(","):
        stripped = part.strip()
        if not stripped:
            raise ValueError("索引列表里有空项：%s" % value)
        # `.kibana` / `.ds-*` / `.security` 是系统索引，和 `_` 开头的 alike 一律不让碰。
        if stripped[0] in ("_", ".") and stripped != "*":
            raise ValueError("不允许访问系统索引：%s" % stripped)
    return value


def check_body(op, body):
    """校验查询体：必须是 JSON 对象，且不含脚本或改数据的字段。"""
    if not OPS[op][3]:
        if body:
            raise ValueError("`%s` 不接受 --body。" % op)
        return None
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError("--body 不是合法 JSON：%s" % exc)
    if not isinstance(parsed, dict):
        raise ValueError("--body 必须是 JSON 对象。")
    hit = FORBIDDEN_BODY_KEYS & {str(k).lower() for k in parsed}
    if hit:
        raise ValueError("查询体里的 %s 会执行脚本或改数据，已拒绝。" % "、".join(sorted(hit)))
    if len(body) > MAX_BODY:
        raise ValueError("--body 最长 %d 字符。" % MAX_BODY)
    return json.dumps(parsed, ensure_ascii=False)


def build(ns, method, path, body):
    cmd = [sys.executable, str(TOOLS / "es_exec.py"), "--read-only",
           "--method", method, "--path", path,
           "--timeout", str(ns.timeout), "--max-rows", str(ns.max_rows)]
    if ns.host:
        cmd += ["-H", ns.host]
    if ns.port:
        cmd += ["-P", str(ns.port)]
    if ns.user:
        cmd += ["-u", ns.user]
    if ns.scheme:
        cmd += ["--scheme", ns.scheme]
    if ns.tls:
        cmd += ["--tls", ns.tls]
    if ns.insecure:
        cmd += ["--insecure", ns.insecure]
    return cmd, body


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="只读查询 Elasticsearch（固定操作枚举，无写开关）。")
    parser.add_argument("op", choices=sorted(OPS), help="操作")
    parser.add_argument("-i", "--index", default=os.environ.get("ES_INDEX", "*"),
                        help="索引名或模式，默认 *")
    parser.add_argument("--body", help="JSON 查询体（仅 search / count）；留空时从 stdin 读")
    parser.add_argument("-H", "--host", default=os.environ.get("ES_HOST", "127.0.0.1"))
    parser.add_argument("-P", "--port", type=int, default=int(os.environ.get("ES_PORT", "9200")))
    parser.add_argument("-u", "--user", default=os.environ.get("ES_USER", "elastic"))
    parser.add_argument("-p", "--password", default=os.environ.get("ES_PASSWORD", ""))
    parser.add_argument("--scheme", default=os.environ.get("ES_SCHEME", ""),
                        help="http / https；留空时按 --tls 推断")
    parser.add_argument("--tls", default=os.environ.get("ES_TLS", ""))
    parser.add_argument("--insecure", default=os.environ.get("ES_INSECURE", ""))
    parser.add_argument("--dry-run", action="store_true", help="只打印请求，不连接")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-rows", type=int, default=200,
                        help="hits / 数组结果最多返回的条数，默认 200")
    return parser.parse_args(argv)


def main(argv=None):
    ns = parse_args(argv if argv is not None else sys.argv[1:])
    ns.timeout = min(max(ns.timeout, 1.0), MAX_TIMEOUT)
    method, template, needs_index, needs_body = OPS[ns.op]

    # 查询体走 stdin：Windows 的命令行长度上限装不下一个大 JSON。
    raw_body = ns.body
    if raw_body is None and needs_body and not sys.stdin.isatty():
        raw_body = sys.stdin.read()

    try:
        if needs_index:
            path = template % check_index(ns.index)
        else:
            path = template
        body = check_body(ns.op, raw_body)
    except ValueError as exc:
        print("拒绝执行：%s" % exc, file=sys.stderr)
        return 3

    cmd, _ = build(ns, method, path, body)

    if ns.dry_run:
        print("%s %s" % (method, path))
        if body:
            print(body)
        return 0

    # 口令走环境变量，不放在 argv 里（避免 ps / 进程列表泄露）。
    env = dict(os.environ)
    env["ES_PASSWORD"] = ns.password or ""
    proc = subprocess.run(cmd, input=(body or "").encode("utf-8"), env=env)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
