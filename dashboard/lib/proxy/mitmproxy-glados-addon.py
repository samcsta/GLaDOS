import json
import os
import stat
import time
from pathlib import Path

BODY_LIMIT = int(os.environ.get("GLADOS_PROXY_BODY_LIMIT", "262144"))
MAX_JSONL_BYTES = int(os.environ.get("GLADOS_PROXY_MAX_JSONL_BYTES", str(64 * 1024 * 1024)))
RETENTION_DAYS = int(os.environ.get("GLADOS_PROXY_RETENTION_DAYS", "14"))
RETENTION_MAX_FILES = int(os.environ.get("GLADOS_PROXY_RETENTION_MAX_FILES", "40"))
RETENTION_MAX_BYTES = int(os.environ.get("GLADOS_PROXY_RETENTION_MAX_BYTES", str(1024 * 1024 * 1024)))
TRAFFIC_JSONL = Path(
    os.environ.get(
        "GLADOS_PROXY_TRAFFIC_JSONL",
        str(Path.home() / ".glados" / "traffic" / "proxy-events.jsonl"),
    )
)

_counter = 0
SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key",
    "x-auth-token", "x-access-token", "x-amz-security-token",
}
SENSITIVE_FIELDS = {
    "password", "passwd", "passphrase", "secret", "token", "access_token",
    "refresh_token", "api_key", "apikey", "authorization", "cookie", "session",
    "sessionid", "client_secret", "private_key",
}
REDACTED = "[REDACTED]"


def _ensure_store():
    TRAFFIC_JSONL.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(TRAFFIC_JSONL.parent, 0o700)
    if not TRAFFIC_JSONL.exists():
        TRAFFIC_JSONL.write_text("")
    os.chmod(TRAFFIC_JSONL, 0o600)


def _headers(headers):
    return {
        str(k): REDACTED if str(k).lower() in SENSITIVE_HEADERS else str(v)
        for k, v in headers.items()
    }


def _header_value(headers, name):
    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value)
    return ""


def _redact_value(value):
    if isinstance(value, dict):
        return {
            key: REDACTED if str(key).lower() in SENSITIVE_FIELDS else _redact_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    return value


def _redact_body(text, content_type):
    if not text:
        return text
    if "json" in str(content_type).lower():
        try:
            return json.dumps(_redact_value(json.loads(text)), separators=(",", ":"))
        except (ValueError, TypeError):
            pass
    for field in SENSITIVE_FIELDS:
        marker = f"{field}="
        start = 0
        while True:
            index = text.lower().find(marker, start)
            if index < 0:
                break
            value_start = index + len(marker)
            value_end = len(text)
            for delimiter in ("&", " ", "\n", "\r"):
                candidate = text.find(delimiter, value_start)
                if candidate >= 0:
                    value_end = min(value_end, candidate)
            text = text[:value_start] + REDACTED + text[value_end:]
            start = value_start + len(REDACTED)
    return text


def _body(raw, content_type=""):
    if raw is None:
        return "", 0, False
    size = len(raw)
    truncated = size > BODY_LIMIT
    sample = raw[:BODY_LIMIT]
    text = sample.decode("utf-8", errors="replace")
    return _redact_body(text, content_type), size, truncated


def _next_id():
    global _counter
    _counter += 1
    return int(time.time() * 1000) * 1000 + (_counter % 1000)


def _prune_archives():
    cutoff = time.time() - max(1, RETENTION_DAYS) * 86400
    archives = sorted(
        TRAFFIC_JSONL.parent.glob("proxy-events-*.jsonl"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    removed = set()
    for item in archives:
        if item.stat().st_mtime < cutoff:
            item.unlink(missing_ok=True)
            removed.add(item)
    archives = [item for item in archives if item not in removed]
    for item in archives[max(1, RETENTION_MAX_FILES):]:
        item.unlink(missing_ok=True)
        removed.add(item)
    archives = [item for item in archives if item not in removed]
    total = sum(item.stat().st_size for item in archives)
    for item in reversed(archives):
        if total <= max(1024 * 1024, RETENTION_MAX_BYTES):
            break
        size = item.stat().st_size
        item.unlink(missing_ok=True)
        total -= size


def _append_event(event):
    _ensure_store()
    encoded = json.dumps(event, separators=(",", ":")) + "\n"
    if TRAFFIC_JSONL.stat().st_size and TRAFFIC_JSONL.stat().st_size + len(encoded.encode("utf-8")) > MAX_JSONL_BYTES:
        stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
        archive = TRAFFIC_JSONL.with_name(f"proxy-events-{stamp}-{os.getpid()}-{_next_id()}.jsonl")
        TRAFFIC_JSONL.replace(archive)
        os.chmod(archive, stat.S_IRUSR | stat.S_IWUSR)
        TRAFFIC_JSONL.write_text("")
        os.chmod(TRAFFIC_JSONL, stat.S_IRUSR | stat.S_IWUSR)
        _prune_archives()
    with TRAFFIC_JSONL.open("a", encoding="utf-8") as fh:
        fh.write(encoded)
    os.chmod(TRAFFIC_JSONL, stat.S_IRUSR | stat.S_IWUSR)


def request(flow):
    tag = flow.request.headers.get("X-GLaDOS-Agent", "")
    flow.metadata["glados_agent_tag"] = str(tag)
    if "X-GLaDOS-Agent" in flow.request.headers:
        del flow.request.headers["X-GLaDOS-Agent"]
    if "X-GLaDOS-Transport" in flow.request.headers:
        del flow.request.headers["X-GLaDOS-Transport"]


def response(flow):
    req = flow.request
    resp = flow.response
    req_headers = _headers(req.headers)
    resp_headers = _headers(resp.headers) if resp else {}
    req_body, req_len, req_truncated = _body(req.raw_content, _header_value(req_headers, "content-type"))
    resp_body, resp_len, resp_truncated = _body(resp.raw_content if resp else b"", _header_value(resp_headers, "content-type"))
    status = int(resp.status_code) if resp else 0
    event = {
        "id": _next_id(),
        "ts": int(time.time() * 1000),
        "method": req.method,
        "url": req.pretty_url,
        "host": req.host,
        "status": status,
        "reqLen": req_len,
        "respLen": resp_len,
        "mime": _header_value(resp_headers, "content-type"),
        "agentTag": str(flow.metadata.get("glados_agent_tag", "")),
        "error": str(flow.error) if getattr(flow, "error", None) else "",
        "request": {
            "line": f"{req.method} {req.path} HTTP/{req.http_version}",
            "headers": req_headers,
            "body": req_body,
            "bodyLen": req_len,
            "bodyTruncated": req_truncated,
        },
        "response": {
            "line": f"HTTP/{resp.http_version if resp else '1.1'} {status} {resp.reason if resp else ''}".rstrip(),
            "headers": resp_headers,
            "body": resp_body,
            "bodyLen": resp_len,
            "bodyTruncated": resp_truncated,
        },
    }
    _append_event(event)


def error(flow):
    if getattr(flow, "response", None) is not None:
        return
    response(flow)
