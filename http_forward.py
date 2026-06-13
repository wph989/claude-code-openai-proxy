#!/usr/bin/env python3
"""
生产级 HTTP 转发代理。

运行方式固定为：
  python http_forward.py

所有参数都在 CONFIG 中维护，避免生产环境启动参数漂移。脚本保留原有的
OpenAI/Anthropic 响应修复能力，但把日志、预览长度、转换上限和超时拆成
彼此独立的配置项。

说明：
  - 支持固定 upstream，也支持客户端直接请求 absolute-form URL。
  - 不实现 HTTPS CONNECT 隧道；浏览器把代理用于 HTTPS 网站时不适用。
  - 不支持 chunked 请求体，因为标准库服务端直接透传 chunked 请求体容易产生
    边界歧义，生产上宁可明确拒绝。
"""

import gzip
import http.client
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import threading
import zlib
from dataclasses import dataclass
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional, TextIO
from urllib.parse import urlsplit, urlunsplit


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "proxy-connection",
}


@dataclass(frozen=True)
class ProxyConfig:
    """代理运行配置；生产部署只改这里，不再从命令行或环境变量读取参数。"""

    host: str = "127.0.0.1"
    port: int = 8080
    upstream: Optional[str] = "https://agentrouter.org/"
    default_scheme: str = "http"

    # 总日志开关独立存在，便于生产中一键静默，同时保留错误响应。
    enable_logging: bool = True
    log_level: int = logging.INFO
    log_request_headers: bool = True
    log_response_headers: bool = True
    log_request_body: bool = True
    log_response_body: bool = True
    pretty_json_logs: bool = False

    # None 表示不限制；请求、响应、转换三者互不影响。
    request_body_log_limit_bytes: Optional[int] = 20
    response_body_log_limit_bytes: Optional[int] = 80
    transform_response_limit_bytes: Optional[int] = None

    # 非流式超时只约束普通响应；流式响应拿到响应头后改用 chunk 间隔超时。
    non_stream_timeout_seconds: float = 30.0
    stream_chunk_timeout_seconds: float = 10.0
    response_read_chunk_size: int = 64 * 1024

    enable_response_transform: bool = True
    drop_thinking: bool = True
    inject_sse_watermark: bool = False
    force_identity_accept_encoding: bool = False
    run_selftest_on_start: bool = False


CONFIG = ProxyConfig()


def _validate_optional_byte_limit(name: str, value: Optional[int]) -> None:
    """None 表示不限；其它值必须非负，避免负数在切片里变成意外行为。"""
    if value is None:
        return
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be None or a non-negative integer")


def validate_config(config: ProxyConfig) -> None:
    """启动前校验配置，让生产配置错误尽早暴露。"""
    if not config.host:
        raise ValueError("host must not be empty")
    if not isinstance(config.port, int) or not (1 <= config.port <= 65535):
        raise ValueError("port must be an integer between 1 and 65535")
    if config.default_scheme not in {"http", "https"}:
        raise ValueError("default_scheme must be 'http' or 'https'")

    if config.upstream:
        parsed = urlsplit(config.upstream)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("upstream must be an http(s) URL with a host")

    if config.non_stream_timeout_seconds <= 0:
        raise ValueError("non_stream_timeout_seconds must be greater than 0")
    if config.stream_chunk_timeout_seconds <= 0:
        raise ValueError("stream_chunk_timeout_seconds must be greater than 0")
    if not isinstance(config.response_read_chunk_size, int) or config.response_read_chunk_size <= 0:
        raise ValueError("response_read_chunk_size must be a positive integer")

    _validate_optional_byte_limit(
        "request_body_log_limit_bytes",
        config.request_body_log_limit_bytes,
    )
    _validate_optional_byte_limit(
        "response_body_log_limit_bytes",
        config.response_body_log_limit_bytes,
    )
    _validate_optional_byte_limit(
        "transform_response_limit_bytes",
        config.transform_response_limit_bytes,
    )


def build_logger(
    config: ProxyConfig,
    stream: Optional[TextIO] = None,
    name: str = "http_forward",
) -> logging.Logger:
    """按配置创建 logger；禁用日志时不移除调用点，只让 logger 自己静默。"""
    logger = logging.getLogger(name)
    logger.handlers.clear()
    logger.propagate = False
    logger.disabled = not config.enable_logging
    logger.setLevel(config.log_level)

    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    handler.setLevel(config.log_level)
    logger.addHandler(handler)
    return logger


def within_transform_limit(body: bytes, config: ProxyConfig) -> bool:
    """判断响应是否允许进入转换流程；None 明确表示无限制。"""
    limit = config.transform_response_limit_bytes
    return limit is None or len(body) <= limit


def is_streaming_response(headers) -> bool:
    """用响应头判断是否是 SSE 流，避免把普通 JSON 请求套用流式超时。"""
    content_type = (headers.get("Content-Type") or "").lower()
    return "text/event-stream" in content_type


def select_response_read_timeout(headers, config: ProxyConfig) -> float:
    """非流式和流式读取超时严格分离，避免两类请求互相污染。"""
    if is_streaming_response(headers):
        return config.stream_chunk_timeout_seconds
    return config.non_stream_timeout_seconds


def _set_connection_timeout(conn, timeout_seconds):
    """http.client 没有公开读超时切换 API，只能在拿到 socket 后调整。"""
    sock = getattr(conn, "sock", None)
    if sock is not None:
        sock.settimeout(timeout_seconds)


def read_response_body(resp, conn, config: ProxyConfig) -> bytes:
    """按响应类型读取 body；流式响应的 socket timeout 表示 chunk 间隔超时。"""
    read_timeout = select_response_read_timeout(resp.headers, config)
    _set_connection_timeout(conn, read_timeout)

    chunks = []
    while True:
        try:
            chunk = resp.read(config.response_read_chunk_size)
        except socket.timeout as exc:
            if is_streaming_response(resp.headers):
                raise TimeoutError(
                    f"stream chunk timeout after {read_timeout} seconds"
                ) from exc
            raise TimeoutError(
                f"non-stream response timeout after {read_timeout} seconds"
            ) from exc
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def header_items(headers):
    if hasattr(headers, "raw_items"):
        return list(headers.raw_items())
    return list(headers.items())


def remove_hop_by_hop(headers):
    out = []
    for name, value in header_items(headers):
        if name.lower() not in HOP_BY_HOP:
            out.append((name, value))
    return out


def response_headers_for_client(headers, body: bytes, transcoded: bool, method: str):
    """生成发给客户端的响应头，集中处理长度、编码和 hop-by-hop 头。"""
    out = []
    preserve_head_length = method.upper() == "HEAD" and not transcoded
    sent_content_length = False

    for name, value in remove_hop_by_hop(headers):
        low = name.lower()
        if low == "content-length":
            if preserve_head_length:
                out.append((name, value))
                sent_content_length = True
            continue
        if transcoded and low == "content-encoding":
            continue
        out.append((name, value))

    if not sent_content_length:
        # 代理已经完整读取响应，统一写入准确长度；HEAD 保留上游长度，避免把语义长度改成 0。
        out.append(("Content-Length", str(len(body))))
    return out


def decode_brotli(body):
    try:
        import brotli

        return brotli.decompress(body)
    except ImportError:
        pass

    brotli_exe = shutil.which("brotli")
    if brotli_exe:
        proc = subprocess.run(
            [brotli_exe, "--decompress", "--stdout"],
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode == 0:
            return proc.stdout
        raise RuntimeError(proc.stderr.decode("utf-8", errors="replace") or f"brotli exit {proc.returncode}")

    raise ImportError("missing Python module 'brotli' and no 'brotli' executable in PATH")


def decode_body(body, headers):
    encoding = headers.get("Content-Encoding", "").lower()
    if not encoding or encoding == "identity":
        return body, "raw"

    try:
        if "br" in encoding:
            return decode_brotli(body), "decoded br"
        if "gzip" in encoding:
            return gzip.decompress(body), "decoded gzip"
        if "deflate" in encoding:
            return zlib.decompress(body), "decoded deflate"
    except Exception as exc:
        return body, f"decode failed: {exc}"

    return body, "raw"


def looks_like_openai_sse(body):
    """粗判：SSE body 头部几个字节是否像 OpenAI chat.completion.chunk 流。"""
    head = body[:4096]
    if not head:
        return False
    markers = (
        b'"object":"chat.completion.chunk"',
        b'"object": "chat.completion.chunk"',
        b'"object":"chat.completion"',
        b'"object": "chat.completion"',
    )
    if any(m in head for m in markers):
        return True
    stripped = head.lstrip()
    return stripped.startswith(b'data: {"id":"chatcmpl-') or stripped.startswith(
        b'data:{"id":"chatcmpl-'
    )


def looks_like_broken_anthropic_sse(body):
    """body 已经是 Anthropic SSE 形态（event:/data: 双行块），但 id 是 OpenAI 风格的 chatcmpl-。

    oneapi 在把 DeepSeek 的 OpenAI 响应包成 Anthropic SSE 时常见这种"半成品"：保留了
    event:/data: 框架，但 message_start 里把 OpenAI 的 id 原样塞了进来。
    """
    if not body:
        return False
    head = body[:16384].decode("utf-8", errors="replace")
    has_anthropic_frame = (
        "event: message_start" in head
        or '"type":"message_start"' in head
        or '"type": "message_start"' in head
    )
    has_openai_id = (
        '"id":"chatcmpl-' in head
        or '"id": "chatcmpl-' in head
    )
    return has_anthropic_frame and has_openai_id


STOP_REASON_MAP = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "content_filter": "refusal",
}


def _rough_tokens(text):
    # 粗略估算：英文 1 token ≈ 4 字符。仅在没有真实 usage 时使用。
    return max(1, (len(text) + 3) // 4)


def transform_openai_sse_to_anthropic_sse(body):
    """把 OpenAI 风格的 chat.completion.chunk SSE 转成 Anthropic Messages SSE。

    输入：bytes（已经过 content-encoding 解码）。
    输出：bytes（Anthropic SSE）。
    """
    text = body.decode("utf-8", errors="replace")

    msg_id = "msg_" + os.urandom(12).hex()
    model = "unknown"
    output_tokens = 0
    input_tokens = 0
    sent_message_start = False
    thinking_open = False
    text_open = False
    thinking_index = 0
    text_index = 1
    stop_reason = "end_turn"
    final_usage = None
    chunks = []

    def emit(event, data):
        chunks.append(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n")

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line or not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except Exception:
            continue

        if not sent_message_start:
            msg_id = obj.get("id") or msg_id
            model = obj.get("model", model)
            emit("message_start", {
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                        "output_tokens": 1,
                        "server_tool_use": None,
                    },
                },
            })
            sent_message_start = True

        for ch in obj.get("choices") or []:
            delta = ch.get("delta") or {}
            rc = delta.get("reasoning_content")
            if rc:
                if not thinking_open:
                    emit("content_block_start", {
                        "type": "content_block_start",
                        "index": thinking_index,
                        "content_block": {"type": "thinking", "thinking": ""},
                    })
                    thinking_open = True
                emit("content_block_delta", {
                    "type": "content_block_delta",
                    "index": thinking_index,
                    "delta": {"type": "thinking_delta", "thinking": rc},
                })

            txt = delta.get("content")
            if txt:
                if thinking_open:
                    emit("content_block_stop", {"type": "content_block_stop", "index": thinking_index})
                    thinking_open = False
                if not text_open:
                    emit("content_block_start", {
                        "type": "content_block_start",
                        "index": text_index,
                        "content_block": {"type": "text", "text": ""},
                    })
                    text_open = True
                output_tokens += _rough_tokens(txt)
                emit("content_block_delta", {
                    "type": "content_block_delta",
                    "index": text_index,
                    "delta": {"type": "text_delta", "text": txt},
                })

            fr = ch.get("finish_reason")
            if fr:
                stop_reason = STOP_REASON_MAP.get(fr, "end_turn")

        u = obj.get("usage")
        if u:
            final_usage = u
            if u.get("prompt_tokens") is not None:
                input_tokens = u["prompt_tokens"]
            if u.get("completion_tokens") is not None:
                output_tokens = u["completion_tokens"]

    if not sent_message_start:
        # 上游没下发任何 chunk；补一个空消息，避免客户端卡在 message_start。
        emit("message_start", {
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "output_tokens": 0,
                    "server_tool_use": None,
                },
            },
        })
        sent_message_start = True

    if thinking_open:
        emit("content_block_stop", {"type": "content_block_stop", "index": thinking_index})
    if text_open:
        emit("content_block_stop", {"type": "content_block_stop", "index": text_index})

    usage = {"output_tokens": output_tokens}
    if input_tokens or (final_usage and final_usage.get("prompt_tokens")):
        usage["input_tokens"] = input_tokens or final_usage.get("prompt_tokens", 0)
    emit("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": stop_reason, "stop_sequence": None},
        "usage": usage,
    })
    emit("message_stop", {"type": "message_stop"})

    return "".join(chunks).encode("utf-8")


def transform_openai_json_to_anthropic_json(body):
    """把非流式 OpenAI chat.completion JSON 转成 Anthropic message JSON。"""
    try:
        obj = json.loads(body)
    except Exception:
        return body
    choices = obj.get("choices") or []
    if not choices:
        return body
    message = choices[0].get("message") or {}
    text_parts = message.get("content") or ""
    reasoning = message.get("reasoning_content") or ""
    content = []
    if reasoning:
        content.append({"type": "thinking", "thinking": reasoning})
    if text_parts:
        content.append({"type": "text", "text": text_parts})
    fr = choices[0].get("finish_reason") or "stop"
    stop_reason = STOP_REASON_MAP.get(fr, "end_turn")
    usage_in = obj.get("usage") or {}
    out = {
        "id": obj.get("id") or ("msg_" + os.urandom(12).hex()),
        "type": "message",
        "role": "assistant",
        "model": obj.get("model", "unknown"),
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage_in.get("prompt_tokens", 0),
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "output_tokens": usage_in.get("completion_tokens", 0),
            "server_tool_use": None,
        },
    }
    return json.dumps(out, ensure_ascii=False).encode("utf-8")


def _parse_sse_events(text):
    """把 SSE 文本切成 [{event, data}, ...] 的列表。容错地处理 \r\n / 缺尾行。"""
    events = []
    current = {}
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if line == "":
            if current:
                events.append(current)
                current = {}
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            current["event"] = line[len("event:"):].lstrip()
        elif line.startswith("data:"):
            current["data"] = line[len("data:"):].lstrip()
        # 其它行（id: / retry:）忽略
    if current:
        events.append(current)
    return events


def _render_sse_events(events):
    out = []
    for ev in events:
        ev_name = ev.get("event") or "message"
        data = ev.get("data") or "{}"
        out.append(f"event: {ev_name}")
        out.append(f"data: {data}")
        out.append("")  # 空行 = 事件分隔
    return "\n".join(out).encode("utf-8")


def fix_broken_anthropic_sse(body, drop_thinking=True, new_id=None):
    """修补 oneapi 出来的"半成品 Anthropic SSE"。

    处理项：
      1. 把 message_start.message.id 从 chatcmpl-XXX 换成 msg_XXX（不换就触发 Claude Code 客户端断言）。
      2. 默认丢弃 content_block type=thinking 整段（避免模型内部推理明文泄露给用户）。
         如果 drop_thinking=False 则把它们当成普通 text 块透传。
      3. 重新编号剩下的 content_block index。
      4. 给 message_start.usage 补全 cache_creation_input_tokens / cache_read_input_tokens /
         server_tool_use 等 Anthropic 必填字段（缺一个 Claude Code 也会报 schema 错）。
      5. 给 message_delta.usage 补 output_tokens。
    """
    import re
    text = body.decode("utf-8", errors="replace")

    if new_id is None:
        new_id = "msg_" + os.urandom(12).hex()
    # 只在 id 字段里替换，避免误伤别处出现的 chatcmpl- 子串
    text = re.sub(
        r'("id"\s*:\s*")chatcmpl-[A-Za-z0-9_\-]+(")',
        r"\g<1>" + new_id + r"\g<2>",
        text,
    )

    events = _parse_sse_events(text)

    # 1) 找出所有 thinking 块的 index
    thinking_indices = set()
    for ev in events:
        if ev.get("event") != "content_block_start":
            continue
        try:
            d = json.loads(ev.get("data") or "{}")
        except Exception:
            continue
        if (d.get("content_block") or {}).get("type") == "thinking":
            thinking_indices.add(d.get("index"))

    # 2) 决定怎么处置 thinking 块
    kept = []
    for ev in events:
        ev_name = ev.get("event")
        if ev_name in ("content_block_start", "content_block_delta", "content_block_stop"):
            try:
                d = json.loads(ev.get("data") or "{}")
                idx = d.get("index")
            except Exception:
                d, idx = None, None
            if idx in thinking_indices:
                if drop_thinking:
                    continue
                if ev_name == "content_block_start":
                    # 把它当成 text 块
                    d["content_block"] = {"type": "text", "text": ""}
                    ev["data"] = json.dumps(d, ensure_ascii=False)
                elif ev_name == "content_block_delta":
                    # thinking_delta -> text_delta，内容拼到 text
                    delta = d.get("delta") or {}
                    if delta.get("type") == "thinking_delta":
                        d["delta"] = {"type": "text_delta", "text": delta.get("thinking", "")}
                        ev["data"] = json.dumps(d, ensure_ascii=False)
        kept.append(ev)

    # 3) 给保留下来的 content_block_start 重新编号
    remap = {}
    next_idx = 0
    for ev in kept:
        if ev.get("event") == "content_block_start":
            try:
                d = json.loads(ev.get("data") or "{}")
            except Exception:
                continue
            old = d.get("index")
            if old is None:
                continue
            if old not in remap:
                remap[old] = next_idx
                next_idx += 1
            d["index"] = remap[old]
            ev["data"] = json.dumps(d, ensure_ascii=False)
        elif ev.get("event") in ("content_block_delta", "content_block_stop"):
            try:
                d = json.loads(ev.get("data") or "{}")
            except Exception:
                continue
            old = d.get("index")
            if old in remap:
                d["index"] = remap[old]
                ev["data"] = json.dumps(d, ensure_ascii=False)

    # 4) 补 message_start.usage 字段
    for ev in kept:
        if ev.get("event") == "message_start":
            try:
                d = json.loads(ev.get("data") or "{}")
            except Exception:
                continue
            msg = d.setdefault("message", {})
            usage = msg.setdefault("usage", {})
            usage.setdefault("input_tokens", 0)
            usage.setdefault("cache_creation_input_tokens", 0)
            usage.setdefault("cache_read_input_tokens", 0)
            usage.setdefault("output_tokens", 1)
            usage.setdefault("server_tool_use", None)
            # 同时把 id 也兜底成新的（万一上游没在顶层 message 给出 id 字段）
            msg.setdefault("id", new_id)
            msg.setdefault("type", "message")
            msg.setdefault("role", "assistant")
            msg.setdefault("content", [])
            msg.setdefault("stop_reason", None)
            msg.setdefault("stop_sequence", None)
            ev["data"] = json.dumps(d, ensure_ascii=False)

    # 5) 补 message_delta.usage.output_tokens
    for ev in kept:
        if ev.get("event") == "message_delta":
            try:
                d = json.loads(ev.get("data") or "{}")
            except Exception:
                continue
            usage = d.setdefault("usage", {})
            usage.setdefault("output_tokens", 0)
            ev["data"] = json.dumps(d, ensure_ascii=False)

    # 6) 强制补齐 SSE 收尾事件：oneapi 出来的破损流经常缺 content_block_stop /
    #    message_delta / message_stop，Claude Code 客户端在 SSE 上会一直等流关闭。
    #    这里在事件序列末尾按状态机补上缺失的事件。

    # 6a) 跟踪已经开过 / 关过哪些 content_block index（用 remap 后的新 index）
    opened_indices = []
    closed_indices = set()
    saw_message_delta = False
    saw_message_stop = False

    for ev in kept:
        ev_name = ev.get("event")
        if ev_name == "content_block_start":
            try:
                d = json.loads(ev.get("data") or "{}")
                idx = d.get("index")
                if idx is not None and idx not in opened_indices:
                    opened_indices.append(idx)
            except Exception:
                pass
        elif ev_name == "content_block_stop":
            try:
                d = json.loads(ev.get("data") or "{}")
                idx = d.get("index")
                if idx is not None:
                    closed_indices.add(idx)
            except Exception:
                pass
        elif ev_name == "message_delta":
            saw_message_delta = True
        elif ev_name == "message_stop":
            saw_message_stop = True

    inserted = {"content_block_stop": [], "message_delta": False, "message_stop": False}

    # 按打开顺序给未关闭的块补 content_block_stop
    for idx in opened_indices:
        if idx in closed_indices:
            continue
        kept.append({
            "event": "content_block_stop",
            "data": json.dumps({"type": "content_block_stop", "index": idx},
                               ensure_ascii=False),
        })
        inserted["content_block_stop"].append(idx)

    # 补 message_delta（如果原本没有）
    if not saw_message_delta:
        kept.append({
            "event": "message_delta",
            "data": json.dumps({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 0},
            }, ensure_ascii=False),
        })
        inserted["message_delta"] = True

    # 补 message_stop（如果原本没有）
    if not saw_message_stop:
        kept.append({
            "event": "message_stop",
            "data": json.dumps({"type": "message_stop"}, ensure_ascii=False),
        })
        inserted["message_stop"] = True

    return _render_sse_events(kept), {
        "new_id": new_id,
        "dropped_thinking_indices": sorted(thinking_indices),
        "renumbered": remap,
        "inserted": inserted,
    }


def _selftest_sample(include_close_events=True):
    """模拟 oneapi 出来的'半成品 Anthropic SSE'。

    include_close_events=True  包含完整的 content_block_stop / message_delta / message_stop
    include_close_events=False 缺收尾事件（你贴的 glm-5.1 那次就是这个形态）

    内容：一个 thinking 块 + 一个 text 块（更接近真实场景）。
    """
    text_block = (
        b"event: content_block_start\n"
        b"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n"
        b"\n"
        b"event: content_block_delta\n"
        b"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n"
        b"\n"
    )
    close_events = b""
    if include_close_events:
        close_events = (
            b"event: content_block_stop\n"
            b"data: {\"type\":\"content_block_stop\",\"index\":1}\n"
            b"\n"
            b"event: message_delta\n"
            b"data: {\"type\":\"message_delta\","
            b"\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null}}\n"
            b"\n"
            b"event: message_stop\n"
            b"data: {\"type\":\"message_stop\"}\n"
            b"\n"
        )
    return (
        b"event: message_start\n"
        b"data: {\"type\":\"message_start\",\"message\":{\"type\":\"message\","
        b"\"model\":\"deepseek-v4-pro\",\"usage\":{\"input_tokens\":100,\"output_tokens\":0},"
        b"\"role\":\"assistant\",\"id\":\"chatcmpl-deadbeefcafe\","
        b"\"content\":[]}}\n"
        b"\n"
        b"event: content_block_start\n"
        b"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n"
        b"\n"
        b"event: content_block_delta\n"
        b"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\","
        b"\"thinking\":\"user said hi\"}}\n"
        b"\n"
        b"event: content_block_stop\n"
        b"data: {\"type\":\"content_block_stop\",\"index\":0}\n"
        b"\n"
        + text_block
        + close_events
    )


def _run_selftest():
    print("=" * 70)
    print("SELFTEST #1: 模拟 oneapi 出来的破损 Anthropic SSE（含收尾事件）")
    print("=" * 70)
    body = _selftest_sample(include_close_events=True)
    print("--- 输入（前 600 字节）---")
    print(body[:600].decode("utf-8"))
    detected = looks_like_broken_anthropic_sse(body)
    print(f"looks_like_broken_anthropic_sse -> {detected}")
    if not detected:
        print("[FAIL] 检测函数没识别出来，bug 在检测逻辑")
        return
    fixed, info = fix_broken_anthropic_sse(body, drop_thinking=True)
    print("--- 输出 ---")
    print(fixed.decode("utf-8"))
    print("--- 信息 ---")
    print(info)
    # 验证关键不变量
    text = fixed.decode("utf-8")
    ok = True
    if "chatcmpl-" in text:
        print("[FAIL] 输出里仍含 chatcmpl-"); ok = False
    if "thinking" in text:
        print("[FAIL] 输出里仍含 thinking"); ok = False
    if '"id": "msg_' not in text and '"id":"msg_' not in text:
        print("[FAIL] 输出里没有 msg_ id"); ok = False
    if "cache_creation_input_tokens" not in text:
        print("[FAIL] usage 字段没补全"); ok = False
    if "event: content_block_stop" not in text:
        print("[FAIL] 缺 content_block_stop"); ok = False
    if "event: message_delta" not in text:
        print("[FAIL] 缺 message_delta"); ok = False
    if "event: message_stop" not in text:
        print("[FAIL] 缺 message_stop"); ok = False
    print("=" * 70)
    print("SELFTEST #1 RESULT:", "PASS" if ok else "FAIL")
    print("=" * 70)

    print()
    print("=" * 70)
    print("SELFTEST #2: 模拟'缺收尾事件'的破损流（你贴的 glm-5.1 那个形态）")
    print("=" * 70)
    body2 = _selftest_sample(include_close_events=False)
    print("--- 输入 ---")
    print(body2.decode("utf-8"))
    fixed2, info2 = fix_broken_anthropic_sse(body2, drop_thinking=True)
    print("--- 输出（应自动补全 content_block_stop / message_delta / message_stop）---")
    print(fixed2.decode("utf-8"))
    print("--- 信息 ---")
    print(info2)
    text2 = fixed2.decode("utf-8")
    ok2 = True
    if "event: content_block_stop" not in text2:
        print("[FAIL] 缺 content_block_stop（应自动补）"); ok2 = False
    if "event: message_delta" not in text2:
        print("[FAIL] 缺 message_delta（应自动补）"); ok2 = False
    if "event: message_stop" not in text2:
        print("[FAIL] 缺 message_stop（应自动补）"); ok2 = False
    print("=" * 70)
    print("SELFTEST #2 RESULT:", "PASS" if ok2 else "FAIL")
    print("=" * 70)


def body_preview(body, limit, headers=None, decode=False, pretty_json=False):
    if not body:
        return "<empty>"

    decode_note = ""
    if decode and headers is not None:
        body, decode_note = decode_body(body, headers)

    if limit is None or limit < 0:
        shown = body
        suffix = ""
    elif len(body) > limit:
        shown = body[:limit]
        suffix = f"\n... <truncated, total {len(body)} bytes>"
    else:
        shown = body
        suffix = ""

    try:
        text = shown.decode("utf-8")
    except UnicodeDecodeError:
        text = shown.hex()

    if pretty_json:
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
            suffix = ""
        except Exception:
            pass

    note = f" <{decode_note}>" if decode_note and decode_note != "raw" else ""
    return text + suffix + note


def format_host_header(host, port, scheme):
    default_port = 443 if scheme == "https" else 80
    if port == default_port:
        return host
    if ":" in host and not host.startswith("["):
        return f"[{host}]:{port}"
    return f"{host}:{port}"


def parse_target(handler):
    path = handler.path
    config = handler.server.config

    if config.upstream:
        parsed = urlsplit(config.upstream)
        scheme = parsed.scheme
        host = parsed.hostname
        port = parsed.port or (443 if scheme == "https" else 80)
        return scheme, host, port, path, format_host_header(host, port, scheme)

    if path.startswith("http://") or path.startswith("https://"):
        parsed = urlsplit(path)
        scheme = parsed.scheme
        host = parsed.hostname
        port = parsed.port or (443 if scheme == "https" else 80)
        upstream_path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        return scheme, host, port, upstream_path, format_host_header(host, port, scheme)

    host_header = handler.headers.get("Host")
    if not host_header:
        raise ValueError("missing Host header")

    parsed = urlsplit(f"http://{host_header}")
    scheme = config.default_scheme
    host = parsed.hostname
    port = parsed.port or (443 if scheme == "https" else 80)
    return scheme, host, port, path, format_host_header(host, port, scheme)


def format_headers_for_log(headers):
    return "\n".join(f"{name}: {value}" for name, value in header_items(headers))


def log_request(logger, config, req_no, handler, body):
    if not logger.isEnabledFor(logging.INFO):
        return
    lines = [
        "",
        "=" * 70,
        f"HTTP REQUEST #{req_no}",
        f"{handler.command} {handler.path} {handler.request_version}",
    ]
    if config.log_request_headers:
        lines.append(format_headers_for_log(handler.headers))
    if config.log_request_body:
        lines.append("")
        lines.append("body:")
        lines.append(body_preview(body, config.request_body_log_limit_bytes))
    lines.append("=" * 70)
    logger.info("\n".join(lines))


def log_response(
    logger,
    config,
    req_no,
    resp,
    body,
    transcoded,
    transcode_kind,
):
    if not logger.isEnabledFor(logging.INFO):
        return
    lines = [
        "",
        "=" * 70,
        f"HTTP RESPONSE #{req_no}",
        f"{resp.status} {resp.reason} transcoded={transcoded} kind={transcode_kind!r}",
    ]
    if config.log_response_headers:
        lines.append(format_headers_for_log(resp.headers))
    if config.log_response_body:
        lines.append("")
        lines.append("body:")
        lines.append(
            body_preview(
                body,
                config.response_body_log_limit_bytes,
                {"Content-Encoding": "identity"} if transcoded else resp.headers,
                decode=not transcoded,
                pretty_json=config.pretty_json_logs,
            )
        )
    lines.append("=" * 70)
    logger.info("\n".join(lines))


class ConfiguredThreadingHTTPServer(ThreadingHTTPServer):
    """把配置和请求计数封装到 server 上，避免 handler 依赖零散动态属性。"""

    daemon_threads = True

    def __init__(self, server_address, handler_class, config, logger):
        validate_config(config)
        super().__init__(server_address, handler_class)
        self.config = config
        self.logger = logger
        self._request_counter = 0
        self._request_counter_lock = threading.Lock()

    def next_request_id(self):
        # 多线程代理需要加锁，否则并发请求下日志编号会出现重复或跳变。
        with self._request_counter_lock:
            self._request_counter += 1
            return self._request_counter


class ForwardHandler(BaseHTTPRequestHandler):
    server_version = "ProductionForwardProxy"

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_PUT(self):
        self.forward()

    def do_DELETE(self):
        self.forward()

    def do_PATCH(self):
        self.forward()

    def do_HEAD(self):
        self.forward()

    def do_OPTIONS(self):
        self.forward()

    def forward(self):
        config = self.server.config
        logger = self.server.logger
        req_no = self.server.next_request_id()
        conn = None

        if self.command == "CONNECT":
            self.send_error(501, "CONNECT is not supported by this simple proxy")
            return

        transfer_encoding = self.headers.get("Transfer-Encoding", "").lower()
        if "chunked" in transfer_encoding:
            self.send_error(501, "chunked request body is not supported")
            return

        try:
            scheme, host, port, upstream_path, upstream_host_header = parse_target(self)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            headers = remove_hop_by_hop(self.headers)
            if config.upstream:
                headers = [(name, value) for name, value in headers if name.lower() != "host"]
                headers.append(("Host", upstream_host_header))
            if config.force_identity_accept_encoding:
                headers = [(name, value) for name, value in headers if name.lower() != "accept-encoding"]
                headers.append(("Accept-Encoding", "identity"))

            log_request(logger, config, req_no, self, body)

            if scheme == "https":
                conn = http.client.HTTPSConnection(
                    host, port, timeout=config.non_stream_timeout_seconds
                )
            else:
                conn = http.client.HTTPConnection(
                    host, port, timeout=config.non_stream_timeout_seconds
                )

            conn.putrequest(self.command, upstream_path, skip_host=True, skip_accept_encoding=True)
            for name, value in headers:
                conn.putheader(name, value)
            conn.endheaders()
            if body:
                conn.send(body)

            resp = conn.getresponse()
            resp_body = read_response_body(resp, conn, config)

            # ---- 协议转换：把 OpenAI 风格响应转成 Anthropic 风格 ----
            out_body = resp_body
            transcoded = False
            transcode_kind = None
            is_anthropic_path = "/v1/messages" in self.path
            content_type = (resp.headers.get("Content-Type") or "").lower()
            content_encoding = (resp.headers.get("Content-Encoding") or "").lower()
            is_sse = is_streaming_response(resp.headers)
            logger.debug(
                "request #%s status=%s path=%r content_type=%r content_encoding=%r "
                "is_anthropic_path=%s is_sse=%s raw_len=%s",
                req_no,
                resp.status,
                self.path,
                content_type,
                content_encoding,
                is_anthropic_path,
                is_sse,
                len(resp_body),
            )
            if (
                config.enable_response_transform
                and is_anthropic_path
                and resp.status == 200
                and resp_body
            ):
                decoded, decode_note = decode_body(resp_body, resp.headers)
                logger.debug(
                    "request #%s decode_note=%r decoded_len=%s head_hex=%r",
                    req_no,
                    decode_note,
                    len(decoded),
                    decoded[:32].hex(),
                )
                if not within_transform_limit(decoded, config):
                    logger.warning(
                        "request #%s skip transform: decoded response %s bytes exceeds "
                        "transform_response_limit_bytes=%s",
                        req_no,
                        len(decoded),
                        config.transform_response_limit_bytes,
                    )
                elif is_sse and looks_like_openai_sse(decoded):
                    try:
                        out_body = transform_openai_sse_to_anthropic_sse(decoded)
                        transcoded = True
                        transcode_kind = "OpenAI SSE -> Anthropic SSE"
                        logger.info(
                            "request #%s transcode %s in=%sB out=%sB",
                            req_no,
                            transcode_kind,
                            len(decoded),
                            len(out_body),
                        )
                    except Exception as exc:
                        logger.warning(
                            "request #%s openai->anthropic SSE transform failed: %r",
                            req_no,
                            exc,
                        )
                        out_body = resp_body
                elif is_sse and looks_like_broken_anthropic_sse(decoded):
                    try:
                        fixed, info = fix_broken_anthropic_sse(
                            decoded, drop_thinking=config.drop_thinking
                        )
                        out_body = fixed
                        transcoded = True
                        transcode_kind = "Broken-Anthropic SSE -> Anthropic SSE"
                        logger.info(
                            "request #%s transcode %s in=%sB out=%sB new_id=%r "
                            "dropped_thinking_indices=%s renumbered=%s",
                            req_no,
                            transcode_kind,
                            len(decoded),
                            len(out_body),
                            info["new_id"],
                            info["dropped_thinking_indices"],
                            info["renumbered"],
                        )
                    except Exception as exc:
                        logger.warning(
                            "request #%s broken-anthropic SSE fix failed: %r",
                            req_no,
                            exc,
                        )
                        out_body = resp_body
                elif not is_sse and decoded.lstrip().startswith(b"{") and (
                    b'"object":"chat.completion"' in decoded[:2048]
                    or b'"object": "chat.completion"' in decoded[:2048]
                ):
                    try:
                        out_body = transform_openai_json_to_anthropic_json(decoded)
                        transcoded = True
                        transcode_kind = "OpenAI JSON -> Anthropic JSON"
                        logger.info(
                            "request #%s transcode %s in=%sB out=%sB",
                            req_no,
                            transcode_kind,
                            len(decoded),
                            len(out_body),
                        )
                    except Exception as exc:
                        logger.warning(
                            "request #%s openai->anthropic JSON transform failed: %r",
                            req_no,
                            exc,
                        )
                        out_body = resp_body
                else:
                    logger.debug(
                        "request #%s no transcode: is_sse=%s looks_like_openai_sse=%s "
                        "looks_like_broken_anthropic_sse=%s is_json=%s",
                        req_no,
                        is_sse,
                        looks_like_openai_sse(decoded) if is_sse else "n/a",
                        looks_like_broken_anthropic_sse(decoded) if is_sse else "n/a",
                        decoded.lstrip().startswith(b"{"),
                    )
            else:
                if not is_anthropic_path:
                    logger.debug("request #%s no transcode: path does not contain /v1/messages", req_no)
                elif resp.status != 200:
                    logger.debug("request #%s no transcode: status=%s", req_no, resp.status)
                elif not resp_body:
                    logger.debug("request #%s no transcode: empty body", req_no)
                elif not config.enable_response_transform:
                    logger.debug("request #%s no transcode: enable_response_transform=False", req_no)

            # 在转码后的 SSE 末尾塞一个不可见的注释行，client 端会忽略，但抓包能直接验证
            if config.inject_sse_watermark and transcoded and is_sse and out_body is not resp_body:
                watermark = (
                    f": watermarked-by-http_forward.py req={req_no} "
                    f"kind={transcode_kind} at={os.environ.get('COMPUTERNAME','?')}\n\n"
                ).encode("utf-8")
                out_body = out_body + watermark
                logger.debug(
                    "request #%s injected SSE watermark comment %sB",
                    req_no,
                    len(watermark),
                )

            self.send_response_only(resp.status, resp.reason)
            for name, value in response_headers_for_client(
                resp.headers,
                out_body,
                transcoded,
                self.command,
            ):
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(out_body)

            log_response(
                logger,
                config,
                req_no,
                resp,
                out_body if transcoded else resp_body,
                transcoded,
                transcode_kind,
            )

        except Exception as exc:
            logger.exception("request #%s forward failed", req_no)
            self.send_response_only(502, "Bad Gateway")
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"forward failed: {exc}\n".encode("utf-8"))
        finally:
            if conn is not None:
                conn.close()

    def log_message(self, format, *args):
        # 禁止 BaseHTTPRequestHandler 额外打印一行访问日志，避免重复。
        return


def main(config: ProxyConfig = CONFIG):
    try:
        # PowerShell 下显式设为 UTF-8，避免中文日志被控制台默认编码弄乱。
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    logger = build_logger(config)

    if config.run_selftest_on_start:
        _run_selftest()
        return

    server = ConfiguredThreadingHTTPServer(
        (config.host, config.port),
        ForwardHandler,
        config,
        logger,
    )

    logger.info(r"""
================================================================
  http_forward.py
  listening on              :  http://{host}:{port}
  upstream                  :  {upstream}
  default_scheme            :  {scheme}
  logging                   :  {logging_enabled}
  request body log limit    :  {request_limit}
  response body log limit   :  {response_limit}
  transform response limit  :  {transform_limit}
  non-stream timeout        :  {non_stream_timeout}s
  stream chunk timeout      :  {stream_chunk_timeout}s
  response transform        :  {response_transform}
================================================================
""".format(
        host=config.host,
        port=config.port,
        upstream=config.upstream or "<absolute-URL mode>",
        scheme=config.default_scheme,
        logging_enabled=config.enable_logging,
        request_limit=config.request_body_log_limit_bytes,
        response_limit=config.response_body_log_limit_bytes,
        transform_limit=config.transform_response_limit_bytes,
        non_stream_timeout=config.non_stream_timeout_seconds,
        stream_chunk_timeout=config.stream_chunk_timeout_seconds,
        response_transform=config.enable_response_transform,
    ))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("received KeyboardInterrupt, shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
