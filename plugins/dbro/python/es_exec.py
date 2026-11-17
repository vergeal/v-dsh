#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Elasticsearch HTTP 执行工具（标准库 urllib，无第三方驱动）

连接参数优先取命令行参数，其次读环境变量，最后用默认值：
    -H/--host      ES_HOST      默认 127.0.0.1
    -P/--port      ES_PORT      默认 9200
    -u/--user      ES_USER      默认 elastic
    -p/--password  ES_PASSWORD  默认空（留空时不发 Authorization 头）
    --scheme       ES_SCHEME    http / https；留空时按 --tls 推断
    --tls          ES_TLS       `1` / `true` 时用 https
    --insecure     ES_INSECURE  `1` / `true` 时不校验证书（自签内网集群）

请求：
    --method  HTTP 方法，GET / POST / HEAD
    --path    以 / 开头的路径，可带 query string
    stdin     请求体（GET / HEAD 时留空）

安全说明：
    本执行器保留完整 HTTP 面，供开发环境直接使用；查数据请走 dbro_search.py，
    那里只有固定只读操作、没有写开关。加 --read-only 会拒绝非 GET/HEAD/POST 的方法，
    以及带 _bulk / _delete_by_query / _update_by_query / _reindex 等写端点的路径。
"""

import argparse
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

WRITE_PATHS = (
    "_bulk", "_delete_by_query", "_update_by_query", "_reindex", "_rollover", "_clone",
    "_split", "_shrink", "_alias", "_close", "_open", "_refresh", "_flush", "_cache",
    "_ingest", "pipeline", "snapshot", "_recovery", "_migration", "_reload", "_upgrade",
    "_doc", "_source", "_update", "_create", "_submit", "_cancel",
)
MAX_BYTES = 2_000_000


def truthy(value):
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="向 Elasticsearch 发一个请求（标准库 urllib），响应按 JSON 输出。")
    parser.add_argument("-H", "--host", default=os.environ.get("ES_HOST", "127.0.0.1"))
    parser.add_argument("-P", "--port", type=int, default=int(os.environ.get("ES_PORT", "9200")))
    parser.add_argument("-u", "--user", default=os.environ.get("ES_USER", "elastic"))
    parser.add_argument("-p", "--password", default=os.environ.get("ES_PASSWORD", ""))
    parser.add_argument("--method", default="GET")
    parser.add_argument("--path", default="/")
    parser.add_argument("--scheme", default=os.environ.get("ES_SCHEME", ""))
    parser.add_argument("--tls", default=os.environ.get("ES_TLS", ""))
    parser.add_argument("--insecure", default=os.environ.get("ES_INSECURE", ""))
    parser.add_argument("--dry-run", action="store_true", help="只打印请求，不连接")
    parser.add_argument("--read-only", action="store_true",
                        help="只读模式：只允许 GET / HEAD / POST 且拒绝写端点路径")
    parser.add_argument("--timeout", type=float, default=30.0, help="超时（秒）")
    parser.add_argument("--max-rows", type=int, default=200,
                        help="hits / 顶层数组最多返回的条数，默认 200")
    return parser.parse_args(argv)


def scheme_for(args):
    if args.scheme:
        return args.scheme.lower()
    return "https" if truthy(args.tls) else "http"


def readonly_reason(method, path, body):
    """--read-only 下的兜底判断；返回拒绝原因，通过则返回 None。"""
    if method not in ("GET", "HEAD", "POST"):
        return "只允许 GET / HEAD / POST，收到 %s" % method
    if body and method in ("GET", "HEAD"):
        return "GET / HEAD 不应带请求体"
    lowered = path.lower()
    for marker in WRITE_PATHS:
        if marker in lowered:
            return "路径包含写端点 %s" % marker
    return None


def cap_hits(payload, limit):
    """把 hits.hits 或顶层数组截到 limit 条，返回 (结果, 是否截断)。"""
    if limit <= 0 or not isinstance(payload, dict):
        return payload, False
    hits = payload.get("hits")
    if isinstance(hits, dict) and isinstance(hits.get("hits"), list):
        inner = hits["hits"]
        if len(inner) > limit:
            trimmed = dict(payload)
            trimmed["hits"] = dict(hits, hits=inner[:limit])
            trimmed["_dbro_truncated"] = "%d / %d hits" % (limit, len(inner))
            return trimmed, True
        return payload, False
    for key in ("indices", "nodes", "records", "configs"):
        value = payload.get(key)
        if isinstance(value, list) and len(value) > limit:
            trimmed = dict(payload)
            trimmed[key] = value[:limit]
            trimmed["_dbro_truncated"] = "%d / %d %s" % (limit, len(value), key)
            return trimmed, True
    return payload, False


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    method = args.method.upper()
    path = args.path if args.path.startswith("/") else "/" + args.path
    body = sys.stdin.buffer.read() if not sys.stdin.isatty() else b""
    body = body or None

    if args.read_only:
        reason = readonly_reason(method, path, body)
        if reason:
            print("拒绝执行（--read-only）：%s" % reason, file=sys.stderr)
            return 3

    url = "%s://%s:%d%s" % (scheme_for(args), args.host, args.port, path)
    if args.dry_run:
        print(method, url)
        if body:
            print(body.decode("utf-8", "replace"))
        return 0

    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if args.user and args.password:
        token = base64.b64encode(("%s:%s" % (args.user, args.password)).encode("utf-8")).decode("ascii")
        headers["Authorization"] = "Basic " + token

    context = None
    if scheme_for(args) == "https":
        context = ssl._create_unverified_context() if truthy(args.insecure) else ssl.create_default_context()

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=max(1.0, args.timeout), context=context) as response:
            raw = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        detail = exc.read(2000).decode("utf-8", "replace")
        print("Elasticsearch 返回 HTTP %d：%s" % (exc.code, detail.strip() or exc.reason), file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print("连接 Elasticsearch 失败：%s" % exc.reason, file=sys.stderr)
        return 1
    except Exception as exc:
        print("请求失败：%s" % exc, file=sys.stderr)
        return 1

    if len(raw) > MAX_BYTES:
        print("注意：响应超过 %d 字节，已截断，请加过滤条件。" % MAX_BYTES, file=sys.stderr)
        raw = raw[:MAX_BYTES]

    text = raw.decode("utf-8", "replace")
    try:
        payload, capped = cap_hits(json.loads(text), args.max_rows)
    except json.JSONDecodeError:
        print(text)
        if len(raw) >= MAX_BYTES:
            return 0
        print("注意：响应不是 JSON，已原样输出。", file=sys.stderr)
        return 0
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    if capped:
        print("注意：结果达到 --max-rows 上限，只保留了前 %d 条（见 _dbro_truncated）。"
              % args.max_rows, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
