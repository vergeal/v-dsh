#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Redis 命令执行工具（redis-py）

连接参数优先取命令行参数，其次读环境变量，最后用默认值：
    -H/--host      REDIS_HOST      默认 127.0.0.1
    -P/--port      REDIS_PORT      默认 6379
    -u/--user      REDIS_USER      默认空（Redis 6+ ACL 用户名；只填口令时留空）
    -p/--password  REDIS_PASSWORD  默认空
    -d/--database  REDIS_DB        默认 0（逻辑库号）
    --tls          REDIS_TLS       `1` / `true` 时用 TLS 连接
    --insecure     REDIS_INSECURE  `1` / `true` 时不校验 TLS 证书

命令来源：
    -e/--command 命令名，参数用 --arg 逐个传（可重复）
    位置参数     命令名；未提供时从 stdin 读一行

安全说明：
    本执行器保留完整命令面，供开发环境直接使用；查库请走 dbro_kv.py，
    那里有只读白名单且没有写开关。加 --read-only 会挡掉已知写命令。
"""

import argparse
import json
import os
import re
import sys

# 与 dbro_kv.py 的判断保持一致的兜底：只认命令首词。
WRITE_FIRST = re.compile(
    r"^(set|setex|psetex|setnx|getset|getdel|getex|append|setbit|setrange|incr|incrby|"
    r"incrbyfloat|decr|decrby|bitop|del|unlink|expire|pexpire|expireat|pexpireat|persist|"
    r"rename|renamenx|move|copy|flushdb|flushall|hset|hmset|hsetnx|hdel|hincrby|"
    r"hincrbyfloat|lpush|rpush|lpushx|rpushx|lpop|rpop|lset|lrem|linsert|ltrim|lmove|"
    r"rpoplpush|sadd|srem|spop|smove|sdiffstore|sinterstore|sunionstore|zadd|zrem|zincrby|"
    r"zpopmax|zpopmin|zdiffstore|zunionstore|zinterstore|zremrangebyscore|zremrangebyrank|"
    r"zremrangebylex|xadd|xdel|xtrim|xack|xgroup|xsetid|xreadgroup|geoadd|eval|evalsha|"
    r"fcall|fcall_ro|script|function|sort|sort_ro|mset|msetnx|shutdown|save|bgsave|"
    r"bgrewriteaof|rewriteaof|migrate|restore|swapdb|multi|exec|discard|watch|unwatch|"
    r"replicaof|slaveof|failover|debug|subscribe|unsubscribe|psubscribe|punsubscribe|"
    r"ssubscribe|blpop|brpop|blmove|brpoplpush|blmpop|bzpopmax|bzpopmin|xread|wait|"
    r"auth|select|hello|reset|failpoint|lolwut)$",
    re.I,
)


def truthy(value):
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="执行一条 Redis 命令（redis-py），结果按 JSON 输出。")
    parser.add_argument("-H", "--host", default=os.environ.get("REDIS_HOST", "127.0.0.1"))
    parser.add_argument("-P", "--port", type=int, default=int(os.environ.get("REDIS_PORT", "6379")))
    parser.add_argument("-u", "--user", default=os.environ.get("REDIS_USER", ""))
    parser.add_argument("-p", "--password", default=os.environ.get("REDIS_PASSWORD", ""))
    parser.add_argument("-d", "--database", default=os.environ.get("REDIS_DB", "0"))
    parser.add_argument("-e", "--command", help="命令名，例如 HGETALL")
    parser.add_argument("--arg", action="append", default=[], dest="args",
                        help="命令参数，可重复")
    parser.add_argument("--tls", default=os.environ.get("REDIS_TLS", ""), help="1/true 用 TLS")
    parser.add_argument("--insecure", default=os.environ.get("REDIS_INSECURE", ""),
                        help="1/true 不校验证书")
    parser.add_argument("--dry-run", action="store_true", help="只打印命令，不连接")
    parser.add_argument("--read-only", action="store_true",
                        help="只读模式：拒绝已知写命令（白名单在 dbro_kv.py）")
    parser.add_argument("--timeout", type=float, default=30.0, help="连接与读写超时（秒）")
    parser.add_argument("--max-rows", type=int, default=200,
                        help="列表/集合类结果最多返回的成员数，默认 200")
    parser.add_argument("cmd", nargs="*", help="命令名（未提供时读 stdin）")
    return parser.parse_args(argv)


def read_command(args):
    if args.command:
        return args.command
    if args.cmd:
        return args.cmd[0]
    if not sys.stdin.isatty():
        line = sys.stdin.readline().strip()
        if line:
            return line.split()[0]
    return ""


def cap_rows(value, limit):
    """把顶层列表 / 字典结果截到 limit 条，返回 (截断后的值, 是否截断)。"""
    if limit <= 0:
        return value, False
    if isinstance(value, (list, tuple)):
        seq = list(value)
        return seq[:limit], len(seq) > limit
    if isinstance(value, dict):
        items = list(value.items())
        return dict(items[:limit]), len(items) > limit
    if isinstance(value, set):
        items = sorted(value, key=lambda v: str(v))
        return items[:limit], len(items) > limit
    return value, False


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    command = read_command(args).strip()
    if not command:
        print("没有命令：用 -e 或位置参数传入。", file=sys.stderr)
        return 2

    if args.read_only and WRITE_FIRST.match(command):
        print("拒绝执行（--read-only）：`%s` 是写命令。" % command, file=sys.stderr)
        return 3

    parts = [command] + list(args.args)
    if args.dry_run:
        print(" ".join(parts))
        return 0

    try:
        import redis
    except ImportError:
        print("缺少 Redis 驱动：pip install redis。", file=sys.stderr)
        return 1

    kwargs = {
        "host": args.host,
        "port": args.port,
        "db": int(args.database or 0),
        "password": args.password or None,
        "socket_timeout": max(1.0, args.timeout),
        "socket_connect_timeout": max(1.0, args.timeout),
        "decode_responses": True,
        "single_connection_client": True,
    }
    if args.user:
        kwargs["username"] = args.user
    if truthy(args.tls):
        kwargs["ssl"] = True
        kwargs["ssl_cert_reqs"] = None if truthy(args.insecure) else "required"
        if truthy(args.insecure):
            kwargs["ssl_check_hostname"] = False

    try:
        client = redis.Redis(**kwargs)
        reply = client.execute_command(*parts)
    except Exception as exc:
        print("执行失败：%s" % exc, file=sys.stderr)
        return 1

    shown, capped = cap_rows(reply, args.max_rows)
    print(json.dumps(shown, ensure_ascii=False, indent=2, default=str, sort_keys=False))
    if capped:
        print("注意：结果达到 --max-rows 上限，只保留了前 %d 项。" % args.max_rows, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
