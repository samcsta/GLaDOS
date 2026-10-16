import json
import os
import stat
import time
import asyncio
import base64
import re
import copy
from urllib.parse import urlsplit
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
WEBSOCKET_JSONL = Path(os.environ.get("GLADOS_PROXY_WEBSOCKET_JSONL", str(TRAFFIC_JSONL.parent / "websocket-events.jsonl")))
SESSION_ID = str(os.environ.get("GLADOS_PROXY_SESSION_ID", ""))
INTERCEPT_DIR = Path(os.environ.get("GLADOS_PROXY_INTERCEPT_DIR", str(TRAFFIC_JSONL.parent / "intercept")))
INTERCEPT_TIMEOUT = 300
_pending_tasks = {}

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
        [*TRAFFIC_JSONL.parent.glob("proxy-events-*.jsonl"), *TRAFFIC_JSONL.parent.glob("websocket-events-*.jsonl")],
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


def _append_event(event, destination=None):
    _ensure_store()
    destination = destination or TRAFFIC_JSONL
    if not destination.exists():
        destination.touch(mode=0o600)
    encoded = json.dumps(event, separators=(",", ":")) + "\n"
    if destination.stat().st_size and destination.stat().st_size + len(encoded.encode("utf-8")) > MAX_JSONL_BYTES:
        stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
        archive = destination.with_name(f"{destination.stem}-{stamp}-{os.getpid()}-{_next_id()}.jsonl")
        destination.replace(archive)
        os.chmod(archive, stat.S_IRUSR | stat.S_IWUSR)
        destination.write_text("")
        os.chmod(destination, stat.S_IRUSR | stat.S_IWUSR)
        _prune_archives()
    with destination.open("a", encoding="utf-8") as fh:
        fh.write(encoded)
    os.chmod(destination, stat.S_IRUSR | stat.S_IWUSR)


def _http_version(value):
    value = str(value or "HTTP/1.1")
    return value if value.startswith("HTTP/") else f"HTTP/{value}"


def _ensure_intercept_store():
    for directory in (INTERCEPT_DIR, INTERCEPT_DIR / "pending", INTERCEPT_DIR / "commands"):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)


def _read_json(file):
    try:
        if file.is_symlink() or file.stat().st_size > 2 * 1024 * 1024:
            return {}
        value = json.loads(file.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _write_json(file, value):
    temporary = file.with_name(file.name + f".{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
        os.chmod(temporary, 0o600)
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def _header_items(headers):
    try:
        return list(headers.items(multi=True))
    except TypeError:
        return list(headers.items())


def _raw_message(flow, phase):
    message = flow.request if phase == "request" else flow.response
    raw_body = message.raw_content or b""
    editable = len(raw_body) <= min(BODY_LIMIT, 768 * 1024)
    reason = "" if editable else "Body exceeds the editable preview limit; forward unchanged or drop."
    try:
        text = raw_body[:min(BODY_LIMIT, 768 * 1024)].decode("utf-8", errors="strict")
        if "\x00" in text:
            raise UnicodeError("Binary body")
    except UnicodeError:
        text = "[Binary body omitted; forward unchanged or drop.]"
        editable = False
        reason = "Binary bodies cannot be edited in the text message editor."
    if phase == "request":
        first = f"{message.method} {message.path} {_http_version(message.http_version)}"
    else:
        first = f"{_http_version(message.http_version)} {message.status_code} {message.reason}".rstrip()
    lines = [first] + [f"{key}: {value}" for key, value in _header_items(message.headers)]
    return "\r\n".join(lines) + "\r\n\r\n" + text, editable, reason


def _replace_headers(message, entries):
    message.headers.clear()
    for key, value in entries:
        if hasattr(message.headers, "add"):
            message.headers.add(key, value)
        else:
            message.headers[key] = value


def _strip_attribution(flow):
    for key in list(flow.request.headers.keys()):
        if str(key).lower().startswith("x-glados-"):
            del flow.request.headers[key]


def _apply_raw(flow, phase, raw):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 1024 * 1024 or "\x00" in raw:
        raise ValueError("Invalid or oversized raw message")
    sections = re.split(r"\r?\n\r?\n", raw, maxsplit=1)
    if len(sections) != 2:
        raise ValueError("Separate headers and body with a blank line")
    lines = sections[0].splitlines()
    if not lines:
        raise ValueError("Missing HTTP message line")
    entries = []
    for line in lines[1:]:
        match = re.fullmatch(r"([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)", line)
        if not match or any(ord(char) < 32 and char != "\t" for char in line):
            raise ValueError("Invalid HTTP header")
        entries.append((match[1], match[2]))
    if phase == "request":
        match = re.fullmatch(r"([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?))", lines[0])
        if not match:
            raise ValueError("Invalid HTTP request line")
        message = flow.request
        if re.match(r"^https?://", match[2], re.I):
            target = urlsplit(match[2])
            if not target.hostname or target.scheme.lower() not in ("http", "https"):
                raise ValueError("Invalid absolute HTTP request target")
            message.url = match[2]
        else:
            if not match[2].startswith(("/", "*")):
                raise ValueError("Request target must be a path or HTTP URL")
            message.path = match[2]
        message.method = match[1]
        message.http_version = match[3]
    else:
        match = re.fullmatch(r"(HTTP/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?)) ([1-5][0-9]{2})(?: ([^\r\n]*))?", lines[0])
        if not match:
            raise ValueError("Invalid HTTP response line")
        message = flow.response
        message.http_version = match[1]
        message.status_code = int(match[2])
        message.reason = match[3] or ""
    _replace_headers(message, entries)
    # The text editor displays raw wire content; preserve Content-Encoding and
    # set its byte length without asking mitmproxy to encode it a second time.
    message.raw_content = sections[1].encode("utf-8")
    for key in list(message.headers.keys()):
        if str(key).lower() in ("content-length", "transfer-encoding"):
            del message.headers[key]
    if message.raw_content or phase == "response" or message.method.upper() not in ("GET", "HEAD"):
        message.headers["Content-Length"] = str(len(message.raw_content))
    _strip_attribution(flow)
    flow.metadata["glados_request_edited" if phase == "request" else "glados_response_edited"] = True


def _control_key(item):
    if item["phase"] == "websocket":
        return "interceptWebsocketClient" if item["fromClient"] else "interceptWebsocketServer"
    return "interceptRequests" if item["phase"] == "request" else "interceptResponses"


async def _await_decision(flow, item, websocket=None):
    pending_file = INTERCEPT_DIR / "pending" / f"{item['id']}.json"
    command_file = INTERCEPT_DIR / "commands" / f"{item['id']}.json"
    try:
        while time.time() * 1000 < item["expiresAt"]:
            control = _read_json(INTERCEPT_DIR / "control.json")
            if control.get(_control_key(item)) is not True:
                break
            command = _read_json(command_file)
            if command:
                command_file.unlink(missing_ok=True)
                if command.get("id") != item["id"]:
                    continue
                if command.get("action") == "drop":
                    if websocket is not None:
                        websocket.drop()
                    else:
                        flow.kill()
                    break
                if command.get("action") == "forward":
                    original = None
                    try:
                        if "raw" in command:
                            if not item["editable"]:
                                raise ValueError("This body is not editable")
                            if websocket is not None:
                                raw = command["raw"]
                                if not isinstance(raw, str) or len(raw.encode("utf-8")) > 1024 * 1024:
                                    raise ValueError("Invalid or oversized WebSocket text")
                                websocket.content = raw.encode("utf-8")
                                item["edited"] = True
                            else:
                                message = flow.request if item["phase"] == "request" else flow.response
                                original = message.copy() if hasattr(message, "copy") else copy.deepcopy(message)
                                _apply_raw(flow, item["phase"], command["raw"])
                        break
                    except (ValueError, TypeError, AttributeError) as error:
                        if original is not None:
                            if item["phase"] == "request":
                                flow.request = original
                            else:
                                flow.response = original
                        item["error"] = str(error)
                        _write_json(pending_file, item)
            await asyncio.sleep(0.1)
    finally:
        pending_file.unlink(missing_ok=True)
        command_file.unlink(missing_ok=True)
        _pending_tasks.pop(item["id"], None)
        if websocket is None and getattr(flow, "intercepted", False):
            flow.resume()
        if item["phase"] == "response":
            _record_response(flow)


def _queue_intercept(flow, phase):
    control = _read_json(INTERCEPT_DIR / "control.json")
    if control.get("interceptRequests" if phase == "request" else "interceptResponses") is not True:
        return False
    if len(_pending_tasks) >= 100:
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    _ensure_intercept_store()
    raw, editable, reason = _raw_message(flow, phase)
    item = {
        "id": f"{phase}-{_next_id()}", "phase": phase, "sessionId": SESSION_ID,
        "method": flow.request.method, "url": flow.request.pretty_url,
        "status": flow.response.status_code if getattr(flow, "response", None) else 0,
        "createdAt": int(time.time() * 1000), "expiresAt": int((time.time() + INTERCEPT_TIMEOUT) * 1000),
        "raw": raw, "editable": editable, "reason": reason,
    }
    _write_json(INTERCEPT_DIR / "pending" / f"{item['id']}.json", item)
    flow.intercept()
    _pending_tasks[item["id"]] = loop.create_task(_await_decision(flow, item))
    return True


def running():
    _ensure_intercept_store()
    # Pending messages belonged to the previous process and cannot be resumed.
    for folder in ("pending", "commands"):
        for file in (INTERCEPT_DIR / folder).glob("*.json"):
            file.unlink(missing_ok=True)


def done():
    for task in list(_pending_tasks.values()):
        task.cancel()


def request(flow):
    tag = flow.request.headers.get("X-GLaDOS-Agent", "")
    flow.metadata["glados_agent_tag"] = str(tag)
    flow.metadata["glados_session_id"] = SESSION_ID
    _strip_attribution(flow)
    _queue_intercept(flow, "request")


def response(flow):
    if not _queue_intercept(flow, "response"):
        _record_response(flow)


def _record_response(flow):
    if flow.metadata.get("glados_recorded"):
        return
    flow.metadata["glados_recorded"] = True
    req = flow.request
    resp = flow.response
    req_headers = _headers(req.headers)
    resp_headers = _headers(resp.headers) if resp else {}
    req_body, req_len, req_truncated = _body(req.raw_content, _header_value(req_headers, "content-type"))
    resp_body, resp_len, resp_truncated = _body(resp.raw_content if resp else b"", _header_value(resp_headers, "content-type"))
    status = int(resp.status_code) if resp else 0
    event = {
        "id": _next_id(),
        "sessionId": SESSION_ID,
        "requestEdited": bool(flow.metadata.get("glados_request_edited", False)),
        "responseEdited": bool(flow.metadata.get("glados_response_edited", False)),
        "edited": bool(flow.metadata.get("glados_request_edited", False) or flow.metadata.get("glados_response_edited", False)),
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
            "line": f"{req.method} {req.path} {_http_version(req.http_version)}",
            "headers": req_headers,
            "body": req_body,
            "bodyLen": req_len,
            "bodyTruncated": req_truncated,
        },
        "response": {
            "line": f"{_http_version(resp.http_version if resp else '1.1')} {status} {resp.reason if resp else ''}".rstrip(),
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
    _record_response(flow)


async def websocket_message(flow):
    messages = flow.websocket.messages if getattr(flow, "websocket", None) else []
    if not messages:
        return
    message = messages[-1]
    key = "interceptWebsocketClient" if message.from_client else "interceptWebsocketServer"
    control = _read_json(INTERCEPT_DIR / "control.json")
    edited = False
    if control.get(key) is True and len(_pending_tasks) < 100:
        _ensure_intercept_store()
        content = message.content.encode("utf-8") if isinstance(message.content, str) else message.content
        binary = not bool(getattr(message, "is_text", False))
        editable = not binary and len(content) <= min(BODY_LIMIT, 768 * 1024)
        reason = "" if editable else "Binary or oversized WebSocket messages can only be forwarded unchanged or dropped."
        if binary:
            raw = base64.b64encode(content[:BODY_LIMIT]).decode("ascii")
        else:
            try:
                raw = content[:min(BODY_LIMIT, 768 * 1024)].decode("utf-8", errors="strict")
            except UnicodeError:
                raw = content[:min(BODY_LIMIT, 768 * 1024)].decode("utf-8", errors="replace")
                editable = False
                reason = "Invalid UTF-8 cannot be edited in the text message editor."
        item = {
            "id": f"websocket-{_next_id()}", "phase": "websocket", "sessionId": SESSION_ID,
            "method": "WS", "url": flow.request.pretty_url, "status": 0,
            "fromClient": bool(message.from_client), "opcode": int(message.type),
            "binary": binary, "encoding": "base64" if binary else "utf-8",
            "createdAt": int(time.time() * 1000), "expiresAt": int((time.time() + INTERCEPT_TIMEOUT) * 1000),
            "raw": raw, "editable": editable, "reason": reason,
        }
        _write_json(INTERCEPT_DIR / "pending" / f"{item['id']}.json", item)
        task = asyncio.create_task(_await_decision(flow, item, message))
        _pending_tasks[item["id"]] = task
        # Mitmproxy awaits this hook before forwarding this individual message.
        # Pausing the HTTPFlow itself would not intercept an upgraded WS frame.
        await task
        edited = item.get("edited", False)
    _record_websocket(flow, message, edited)


def _record_websocket(flow, message, edited=False):
    content = message.content
    if isinstance(content, str):
        content = content.encode("utf-8")
    binary = not bool(getattr(message, "is_text", False))
    if binary:
        body = base64.b64encode(content[:BODY_LIMIT]).decode("ascii")
    else:
        body = _redact_body(content[:BODY_LIMIT].decode("utf-8", errors="replace"), "application/json")
    _append_event({
        "type": "websocket", "id": _next_id(), "sessionId": SESSION_ID,
        "ts": int(float(getattr(message, "timestamp", time.time())) * 1000),
        "url": flow.request.pretty_url, "agentTag": str(flow.metadata.get("glados_agent_tag", "")),
        "fromClient": bool(message.from_client), "opcode": int(message.type),
        "body": body, "bodyLen": len(content), "bodyTruncated": len(content) > BODY_LIMIT,
        "binary": binary, "encoding": "base64" if binary else "utf-8",
        "dropped": bool(getattr(message, "dropped", False)), "edited": bool(edited),
    }, WEBSOCKET_JSONL)
