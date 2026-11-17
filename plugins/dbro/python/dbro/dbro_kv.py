#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Redis 只读命令入口。

和 dbro.py 对 SQL 的角色一样：本脚本**没有任何写开关**，只放行白名单里的只读命令。
不要直接调 redis_exec.py，那个执行器留着完整命令面。

防护是默认拒绝的：命令必须出现在 `READONLY_COMMANDS` 里，依赖子命令判断的（OBJECT、
CONFIG、CLIENT……）还要再过一层 `READONLY_SUBCOMMANDS`。新命令不加进白名单就执行不了，
所以漏判的方向是“少放行”，不是“多放行”。

有意不放的命令，以及理由：
- `KEYS`：O(N) 扫描会阻塞整个实例，影响别人；用 `SCAN` 或 dbro_kv_scan。
- `SORT`：带 `STORE` 会写；只读的 `SORT_RO` 各版本可用性不一，一并留给只读账号方案。
- `EVAL` / `EVAL_RO` / `FCALL` / `SCRIPT`：脚本可以读写任意键，静态白名单判不出来。
- `SUBSCRIBE` / `BLPOP` / `XREAD BLOCK`：长连接与阻塞，和“一条命令一个进程”不兼容。
- `CONFIG SET` / `DEBUG` / `SHUTDOWN` / `SAVE` / `FLUSH*`：改服务端状态。

Redis 没有只读事务可以兜底，所以第三层保障只能是账号：把数据源配成 Redis 6+ 的只读
ACL 用户，例如 `ACL SETUSER readonly on >pw ~* &* -@all +@read +@fast +INFO +SCAN`。

用法：
    dbro_kv.py -e "HGETALL user:1" -H 10.0.0.9 -d 2
    echo "INFO memory" | dbro_kv.py -H 10.0.0.9
"""

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
MAX_TIMEOUT = 120.0
MAX_ARGS = 64

# 服务端与键元信息
SERVER = {"PING", "ECHO", "INFO", "DBSIZE", "TIME", "LASTSAVE", "MEMORY", "CLIENT",
          "COMMAND", "ACL", "LATENCY", "SLOWLOG", "CONFIG", "CLUSTER", "PUBSUB"}

# 键的只读探查
KEY_META = {"EXISTS", "TYPE", "TTL", "PTTL", "EXPIRETIME", "PEXPIRETIME", "RANDOMKEY",
            "OBJECT", "DUMP", "SCAN"}

# 各数据类型的只读命令
READONLY_COMMANDS = SERVER | KEY_META | {
    # string
    "GET", "MGET", "GETRANGE", "STRLEN", "SUBSTR", "GETBIT", "BITCOUNT", "BITPOS", "LCS",
    # hash
    "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN",
    "HRANDFIELD", "HSTRLEN",
    # list
    "LRANGE", "LLEN", "LINDEX", "LPOS",
    # set
    "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER", "SSCAN", "SRANDMEMBER",
    "SDIFF", "SINTER", "SUNION", "SINTERCARD",
    # sorted set
    "ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE",
    "ZREVRANGEBYLEX", "ZCARD", "ZCOUNT", "ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK",
    "ZLEXCOUNT", "ZSCAN", "ZRANDMEMBER",
    # stream：只放行不创建 consumer、不改动 pending 列表的
    "XLEN", "XRANGE", "XREVRANGE", "XINFO", "XPENDING",
    # geo：只放行明确只读的变体
    "GEOPOS", "GEODIST", "GEORADIUS_RO", "GEORADIUSBYMEMBER_RO", "GEOSEARCH",
}

# 顶层命令只读与否取决于子命令
READONLY_SUBCOMMANDS = {
    "OBJECT": {"ENCODING", "FREQ", "IDLETIME", "REFCOUNT"},
    "MEMORY": {"USAGE", "STATS", "DOCTOR"},
    "CLIENT": {"LIST", "INFO", "GETNAME", "ID", "CAPA"},
    "CONFIG": {"GET"},
    "COMMAND": {"COUNT", "DOCS", "INFO", "GETKEYS", "GETKEYSANDFLAGS", "LIST"},
    "ACL": {"WHOAMI", "LIST", "CAT", "DOCS", "GETUSER"},
    "LATENCY": {"DOCS", "LATEST", "HISTORY"},
    "SLOWLOG": {"GET", "LEN"},
    "XINFO": {"STREAM", "GROUPS", "CONSUMERS"},
    "PUBSUB": {"CHANNELS", "NUMSUB", "SHARDCHANNELS", "SHARDNUMSUB"},
    "CLUSTER": {"INFO", "SHARDS", "NODES", "SLOTS", "KEYSLOT", "COUNTKEYSINSLOT", "MYID"},
}

# 写命令的显式报错表：命中就给“这是写命令”的理由，而不是笼统的不在白名单
WRITE_COMMANDS = {
    "SET", "SETEX", "PSETEX", "SETNX", "GETSET", "GETDEL", "GETEX", "APPEND", "SETBIT",
    "SETRANGE", "INCR", "INCRBY", "INCRBYFLOAT", "DECR", "DECRBY", "BITOP", "DEL", "UNLINK",
    "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "EXPIRENX", "PERSIST", "RENAME", "RENAMENX",
    "MOVE", "COPY", "FLUSHDB", "FLUSHALL", "HSET", "HMSET", "HSETNX", "HDEL", "HINCRBY",
    "HINCRBYFLOAT", "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM",
    "LINSERT", "LTRIM", "LMOVE", "RPOPLPUSH", "SADD", "SREM", "SPOP", "SMOVE", "SDIFFSTORE",
    "SINTERSTORE", "SUNIONSTORE", "ZADD", "ZREM", "ZINCRBY", "ZPOPMAX", "ZPOPMIN", "ZDIFFSTORE",
    "ZUNIONSTORE", "ZINTERSTORE", "ZREMRANGEBYSCORE", "ZREMRANGEBYRANK", "ZREMRANGEBYLEX",
    "XADD", "XDEL", "XTRIM", "XACK", "XGROUP", "XSETID", "XREADGROUP", "GEOADD",
    "EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO", "SCRIPT", "FUNCTION",
    "SORT", "SORT_RO", "KEYS", "MSET", "MSETNX", "SETNX", "SHUTDOWN", "SAVE", "BGSAVE",
    "BGREWRITEAOF", "REWRITEAOF", "MIGRATE", "RESTORE", "SWAPDB", "MULTI", "EXEC", "DISCARD",
    "WATCH", "UNWATCH", "REPLICAOF", "SLAVEOF", "FAILOVER", "DEBUG", "SUBSCRIBE",
    "UNSUBSCRIBE", "PSUBSCRIBE", "PUNSUBSCRIBE", "SSUBSCRIBE", "BLPOP", "BRPOP", "BLMOVE",
    "BRPOPLPUSH", "BLMPOP", "BZPOPMAX", "BZPOPMIN", "XREAD", "WAIT", "AUTH", "SELECT",
    "HELLO", "RESET", "LOLWUT", "FAILPOINT",
}


def normalize(raw):
    """把输入切成 token 列表；多行输入直接拒绝。"""
    lines = [line for line in raw.splitlines() if line.strip()]
    if len(lines) > 1:
        raise ValueError("只允许一条命令，检测到 %d 行。" % len(lines))
    try:
        tokens = shlex.split(lines[0]) if lines else []
    except ValueError as exc:
        raise ValueError("命令解析失败：%s（参数里有未闭合的引号？）" % exc)
    if not tokens:
        raise ValueError("没有命令。")
    if len(tokens) > MAX_ARGS + 1:
        raise ValueError("命令参数过多（上限 %d 个）。" % MAX_ARGS)
    return tokens


def check(tokens):
    """校验命令是否只读；通过返回 (命令, 参数列表)，否则抛 ValueError。"""
    command = tokens[0].upper()
    args = tokens[1:]

    if not command.replace("-", "").isalpha():
        raise ValueError("第一个 token 必须是命令名，收到：%s" % tokens[0])
    if command in ("KEYS", "SORT", "SORT_RO"):
        raise ValueError("`%s` 已禁用：KEYS 会阻塞整个实例，SORT 带 STORE 会写入。"
                         "改用 SCAN 或 LRANGE + 排序。" % command)
    if command in ("EVAL", "EVALSHA", "EVAL_RO", "FCALL", "FCALL_RO", "SCRIPT", "FUNCTION"):
        raise ValueError("脚本类命令可以读写任意键，静态白名单判不出来，一律拒绝。")
    if command in WRITE_COMMANDS:
        raise ValueError("`%s` 是写命令，本入口没有写开关。" % command)
    if command not in READONLY_COMMANDS:
        raise ValueError("`%s` 不在只读命令白名单里。" % command)

    allowed = READONLY_SUBCOMMANDS.get(command)
    if allowed is not None:
        if not args:
            raise ValueError("`%s` 需要子命令，只放行：%s" % (command, "、".join(sorted(allowed))))
        sub = args[0].upper()
        if sub not in allowed:
            raise ValueError("`%s %s` 不是只读子命令，只放行：%s"
                             % (command, sub, "、".join(sorted(allowed))))

    # GEOSEARCH 是同一个命令名兼顾读写，只能按参数区分。
    if command == "GEOSEARCH" and any(a.upper() in ("STORE", "STOREDIST") for a in args):
        raise ValueError("`GEOSEARCH ... STORE` 会写入，已拒绝。")
    return command, args


def build(ns, command, args):
    cmd = [sys.executable, str(TOOLS / "redis_exec.py"), "--read-only", "-e", command]
    if args:
        cmd += ["--arg", *args]
    if ns.user:
        cmd += ["-u", ns.user]
    if ns.database:
        cmd += ["-d", ns.database]
    cmd += ["-H", ns.host, "-P", str(ns.port), "--timeout", str(ns.timeout),
            "--max-rows", str(ns.max_rows)]
    return cmd


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="只读执行一条 Redis 命令（白名单，无写开关）。")
    parser.add_argument("-e", "--command", help="命令字符串，例如 \"HGETALL user:1\"")
    parser.add_argument("-H", "--host", default=os.environ.get("REDIS_HOST", "127.0.0.1"))
    parser.add_argument("-P", "--port", type=int, default=int(os.environ.get("REDIS_PORT", "6379")))
    parser.add_argument("-u", "--user", default=os.environ.get("REDIS_USER", ""))
    parser.add_argument("-p", "--password", default=os.environ.get("REDIS_PASSWORD", ""))
    parser.add_argument("-d", "--database", default=os.environ.get("REDIS_DB", ""),
                        help="逻辑库号，默认 0")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-rows", type=int, default=200,
                        help="集合类命令最多返回的成员数，默认 200")
    return parser.parse_args(argv)


def main(argv=None):
    ns = parse_args(argv if argv is not None else sys.argv[1:])
    raw = ns.command if ns.command else ("" if sys.stdin.isatty() else sys.stdin.read())
    if not raw.strip():
        print("没有命令：用 -e 或管道传入。", file=sys.stderr)
        return 2

    try:
        command, args = check(normalize(raw.strip()))
    except ValueError as exc:
        print("拒绝执行：%s" % exc, file=sys.stderr)
        return 3

    ns.timeout = min(max(ns.timeout, 1.0), MAX_TIMEOUT)

    # 口令走环境变量，不放在 argv 里（避免 ps / 进程列表泄露）。
    env = dict(os.environ)
    env["REDIS_PASSWORD"] = ns.password or ""
    proc = subprocess.run(build(ns, command, args), env=env)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
