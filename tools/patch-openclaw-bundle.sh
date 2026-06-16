#!/bin/bash
# patch-openclaw-bundle.sh — Idempotent patch of openclaw's pi-embedded bundle
# so every per-agent tool.execute() runs inside AsyncLocalStorage.run(agentId, …).
# Re-apply after every `npm install -g openclaw` upgrade.
#
# The seam is wrapToolWithBeforeToolCallHook(tool, ctx) in pi-embedded-*.js.
# We wrap the whole execute() arrow body in:
#
#   const _gladosAls = globalThis.__gladosAgentALS;
#   const _gladosRun = async () => { <original body> };
#   if (_gladosAls && ctx && ctx.agentId) return _gladosAls.run(ctx.agentId, _gladosRun);
#   return _gladosRun();
#
# The fallthrough `return _gladosRun()` keeps openclaw functional if the
# tag-injector preload fails to load.

set -euo pipefail

DIST="${OPENCLAW_DIST:-$(npm root -g)/openclaw/dist}"
if [ ! -d "$DIST" ]; then
  echo "[patch] openclaw dist not found: $DIST" >&2
  exit 1
fi
# Find the bundle containing wrapToolWithBeforeToolCallHook (the seam we patch).
BUNDLE=$(grep -l "wrapToolWithBeforeToolCallHook" "$DIST"/pi-embedded-*.js 2>/dev/null | head -n 1)
if [ -z "${BUNDLE:-}" ]; then
  echo "[patch] could not find bundle containing wrapToolWithBeforeToolCallHook" >&2
  exit 1
fi
echo "[patch] target: $BUNDLE"

MARKER="GLADOS_ALS_PATCH_V1"
if grep -q "$MARKER" "$BUNDLE"; then
  echo "[patch] ALS patch already applied ($MARKER present) — skipping"
  PI_PATCHED=1
else
  PI_PATCHED=0
fi

# Back up once.
[ -f "$BUNDLE.pre-glados.bak" ] || cp "$BUNDLE" "$BUNDLE.pre-glados.bak"

if [ "$PI_PATCHED" = "0" ]; then
python3 - "$BUNDLE" <<'PYEOF'
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# Anchor 1: start of the execute arrow body inside wrapToolWithBeforeToolCallHook.
start_needle = (
    '\t\texecute: async (toolCallId, params, signal, onUpdate) => {\n'
    '\t\t\tconst outcome = await runBeforeToolCallHook({\n'
)
# Anchor 2: the unique end of that same function: try-catch closing, then the
# arrow fn's closing brace, then the wrappedTool object's closing brace+semi.
end_needle = (
    '\t\t\t\tthrow err;\n'
    '\t\t\t}\n'
    '\t\t}\n'
    '\t};\n'
)

if start_needle not in src:
    sys.stderr.write("[patch] could not locate execute arrow start\n")
    sys.exit(2)
if end_needle not in src:
    sys.stderr.write("[patch] could not locate execute arrow end\n")
    sys.exit(3)

# Replace start: inject ALS bindings and open _gladosRun wrapper.
start_repl = (
    '\t\texecute: async (toolCallId, params, signal, onUpdate) => {\n'
    '\t\t\t/* GLADOS_ALS_PATCH_V1 */\n'
    '\t\t\tconst _gladosAls = globalThis.__gladosAgentALS;\n'
    '\t\t\tconst _gladosRun = async () => {\n'
    '\t\t\tconst outcome = await runBeforeToolCallHook({\n'
)

# Replace end: close _gladosRun wrapper, then branch on ALS availability.
end_repl = (
    '\t\t\t\tthrow err;\n'
    '\t\t\t}\n'
    '\t\t\t}; /* end _gladosRun */\n'
    '\t\t\tif (_gladosAls && ctx && ctx.agentId) return _gladosAls.run(ctx.agentId, _gladosRun);\n'
    '\t\t\treturn _gladosRun();\n'
    '\t\t}\n'
    '\t};\n'
)

out = src.replace(start_needle, start_repl, 1).replace(end_needle, end_repl, 1)

if out == src:
    sys.stderr.write("[patch] no substitutions made\n")
    sys.exit(4)

with open(path, "w", encoding="utf-8") as f:
    f.write(out)

print("[patch] applied GLADOS_ALS_PATCH_V1")
PYEOF

# Sanity: ensure Node can still parse the file.
node --check "$BUNDLE" && echo "[patch] syntax ok"
fi  # end PI_PATCHED gate

# ---------------------------------------------------------------------------
# Second patch: force openclaw's hardened createPinnedDispatcher to route via
# Burp instead of using a direct Agent. Without this, web_fetch / web_search /
# guarded tool fetches bypass HTTPS_PROXY env entirely (SSRF-pinned direct
# Agent), so Burp never sees that traffic.
# ---------------------------------------------------------------------------
SSRF=$(grep -l "function createPinnedDispatcher" "$DIST"/ssrf-*.js 2>/dev/null | head -n 1)
if [ -z "${SSRF:-}" ]; then
  echo "[patch] WARNING: could not find ssrf bundle — guarded fetches will bypass Burp" >&2
  SSRF_SKIP=1
else
  echo "[patch] target (ssrf): $SSRF"
  SSRF_SKIP=0
fi

# v3.1.04242026 — V2 adds HMAC signed header + ACL host-glob check inside
# the dispatcher wrapper. If the bundle has V1 applied, we restore from .bak
# and re-apply V2. If neither is present, apply V2 from scratch.
MARKER2="GLADOS_SSRF_ROUTE_V1"
MARKER2B="GLADOS_SSRF_ROUTE_V2"
SSRF_PATCHED=0
if [ "$SSRF_SKIP" = "0" ] && grep -q "$MARKER2B" "$SSRF"; then
  echo "[patch] ssrf already at V2 ($MARKER2B present) — skipping"
  SSRF_PATCHED=1
fi

if [ "$SSRF_SKIP" = "0" ] && [ "$SSRF_PATCHED" = "0" ] && grep -q "$MARKER2" "$SSRF"; then
  if [ -f "$SSRF.pre-glados.bak" ]; then
    echo "[patch] ssrf at V1; restoring from .pre-glados.bak and re-applying V2"
    cp "$SSRF.pre-glados.bak" "$SSRF"
  else
    echo "[patch] ssrf at V1 but no .bak found — bailing on V2 upgrade to avoid corrupting bundle" >&2
    SSRF_PATCHED=1
  fi
fi

if [ "$SSRF_SKIP" = "0" ] && [ "$SSRF_PATCHED" = "0" ]; then
[ -f "$SSRF.pre-glados.bak" ] || cp "$SSRF" "$SSRF.pre-glados.bak"

python3 - "$SSRF" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# The direct-mode dispatcher branch in createPinnedDispatcher:
needle = '\tif (!policy || policy.mode === "direct") return new Agent({ connect: withPinnedLookup(lookup, policy?.connect) });\n'
if needle not in src:
    sys.stderr.write("[patch] could not locate direct-Agent branch in createPinnedDispatcher\n")
    sys.exit(2)

# V2: route direct-mode fetches through Burp WITH per-request agent tagging
# (X-GLaDOS-Agent + HMAC-signed X-GLaDOS-Agent-Signed) AND ACL host-glob
# enforcement BEFORE dispatch. Localhost / link-local pinned hosts bypass.
# Kill-switch via GLADOS_DISABLE_BURP_ROUTE=1. Out-of-scope agents get a
# direct Agent so their LLM / internal traffic never lands in Burp history.
#
# V2 adds (vs V1):
#   - HMAC X-GLaDOS-Agent-Signed via globalThis.__gladosSignAgent
#   - ACL gate via globalThis.__gladosAclAllows; deny -> abort dispatch with
#     a synthesised error matching tag-injector's GLADOS_ACL_DENY shape.
repl = (
    '\t/* GLADOS_SSRF_ROUTE_V2 */\n'
    '\tif (!policy || policy.mode === "direct") {\n'
    '\t\tconst _direct = () => new Agent({ connect: withPinnedLookup(lookup, policy?.connect) });\n'
    '\t\tif (process.env.GLADOS_DISABLE_BURP_ROUTE === "1") return _direct();\n'
    '\t\tconst _als = globalThis.__gladosAgentALS;\n'
    '\t\tconst _agent = _als ? _als.getStore() : null;\n'
    '\t\tconst _scope = new Set([\n'
    '\t\t\t"osint","origin-ip","net-recon","webapp-recon","source-code",\n'
    '\t\t\t"webapp-vuln","webapp-validator","api-expert","api-validator",\n'
    '\t\t\t"poc-coder","poc-validator","postex","postex-validator",\n'
    '\t\t\t"ad-expert","ad-validator","c2-builder","c2-validator",\n'
    '\t\t\t"phisherman","phish-validator"\n'
    '\t\t]);\n'
    '\t\tif (!_agent || !_scope.has(_agent)) return _direct();\n'
    '\t\tconst _pinnedIp = pinned && (pinned.ip || pinned.pinnedIp || pinned.address);\n'
    '\t\tif (_pinnedIp && (/^127\\./.test(_pinnedIp) || _pinnedIp === "::1" || /^fe80:/.test(_pinnedIp))) return _direct();\n'
    '\t\tconst _burp = new ProxyAgent("http://127.0.0.1:8080");\n'
    '\t\tconst _origDispatch = _burp.dispatch.bind(_burp);\n'
    '\t\t_burp.dispatch = function(opts, handler) {\n'
    '\t\t\t/* ACL: derive target host then deny if not allowed. */\n'
    '\t\t\ttry {\n'
    '\t\t\t\tconst _aclFn = globalThis.__gladosAclAllows;\n'
    '\t\t\t\tlet _aclHost = null;\n'
    '\t\t\t\ttry {\n'
    '\t\t\t\t\tif (typeof opts.origin === "string") _aclHost = new URL(opts.origin).hostname;\n'
    '\t\t\t\t\telse if (opts.origin && opts.origin.host) _aclHost = String(opts.origin.host).split(":")[0];\n'
    '\t\t\t\t\tif (!_aclHost && typeof opts.path === "string") {\n'
    '\t\t\t\t\t\tconst _u = opts.path.match(/^https?:\\/\\/([^\\/:]+)/i);\n'
    '\t\t\t\t\t\tif (_u) _aclHost = _u[1];\n'
    '\t\t\t\t\t}\n'
    '\t\t\t\t} catch(_) {}\n'
    '\t\t\t\tif (_aclFn && _aclHost) {\n'
    '\t\t\t\t\tconst _v = _aclFn(_agent, _aclHost);\n'
    '\t\t\t\t\tif (_v && _v.allowed === false) {\n'
    '\t\t\t\t\t\tconst _err = new Error("GLADOS_ACL_DENY agent=" + _agent + " host=" + _aclHost + " reason=" + (_v.reason || "deny"));\n'
    '\t\t\t\t\t\t_err.code = "GLADOS_ACL_DENY";\n'
    '\t\t\t\t\t\ttry { handler && handler.onError && handler.onError(_err); } catch(_){}\n'
    '\t\t\t\t\t\ttry { process.stderr.write("[ssrf-patch] ACL DENY " + _agent + " -> " + _aclHost + " (" + _v.reason + ")\\n"); } catch(_){}\n'
    '\t\t\t\t\t\treturn false;\n'
    '\t\t\t\t\t}\n'
    '\t\t\t\t}\n'
    '\t\t\t} catch(_) {}\n'
    '\t\t\t/* Header injection: plain + signed. */\n'
    '\t\t\ttry {\n'
    '\t\t\t\tconst _signFn = globalThis.__gladosSignAgent;\n'
    '\t\t\t\tconst _signed = (typeof _signFn === "function") ? _signFn(_agent) : null;\n'
    '\t\t\t\tconst h = opts.headers;\n'
    '\t\t\t\tif (Array.isArray(h)) {\n'
    '\t\t\t\t\tlet hasPlain = false, hasSigned = false;\n'
    '\t\t\t\t\tfor (let i = 0; i < h.length; i += 2) {\n'
    '\t\t\t\t\t\tif (typeof h[i] === "string") {\n'
    '\t\t\t\t\t\t\tconst k = h[i].toLowerCase();\n'
    '\t\t\t\t\t\t\tif (k === "x-glados-agent") hasPlain = true;\n'
    '\t\t\t\t\t\t\telse if (k === "x-glados-agent-signed") hasSigned = true;\n'
    '\t\t\t\t\t\t}\n'
    '\t\t\t\t\t}\n'
    '\t\t\t\t\tif (!hasPlain) { h.push("X-GLaDOS-Agent"); h.push(_agent); }\n'
    '\t\t\t\t\tif (!hasSigned && _signed) { h.push("X-GLaDOS-Agent-Signed"); h.push(_signed); }\n'
    '\t\t\t\t} else if (h && typeof h === "object") {\n'
    '\t\t\t\t\tconst lower = Object.keys(h).map(k => k.toLowerCase());\n'
    '\t\t\t\t\tif (!lower.includes("x-glados-agent")) h["X-GLaDOS-Agent"] = _agent;\n'
    '\t\t\t\t\tif (!lower.includes("x-glados-agent-signed") && _signed) h["X-GLaDOS-Agent-Signed"] = _signed;\n'
    '\t\t\t\t} else {\n'
    '\t\t\t\t\topts.headers = { "X-GLaDOS-Agent": _agent };\n'
    '\t\t\t\t\tif (_signed) opts.headers["X-GLaDOS-Agent-Signed"] = _signed;\n'
    '\t\t\t\t}\n'
    '\t\t\t} catch (_) {}\n'
    '\t\t\treturn _origDispatch(opts, handler);\n'
    '\t\t};\n'
    '\t\treturn _burp;\n'
    '\t}\n'
)

out = src.replace(needle, repl, 1)
if out == src:
    sys.stderr.write("[patch] no substitution made in ssrf\n")
    sys.exit(3)

with open(path, "w", encoding="utf-8") as f:
    f.write(out)

print("[patch] applied GLADOS_SSRF_ROUTE_V2")
PYEOF

node --check "$SSRF" && echo "[patch] ssrf syntax ok"
fi  # end SSRF_PATCHED gate

# ---------------------------------------------------------------------------
# Third patch: hard plan-gate at sessions_spawn execute(). Reads
# globalThis.__gladosPlanGate(agentId) (installed by tag-injector) and
# refuses the spawn if it returns { allowed: false }. This makes the
# Phase 1 → Phase 2 → Phase 3 invariant a runtime boundary, not just a
# SOUL.md prompt rule.
# ---------------------------------------------------------------------------
GATE_BUNDLE=$(grep -l "function createSessionsSpawnTool" "$DIST"/pi-embedded-*.js 2>/dev/null | head -n 1)
if [ -z "${GATE_BUNDLE:-}" ]; then
  echo "[patch] WARNING: could not find bundle containing createSessionsSpawnTool" >&2
  exit 0
fi
echo "[patch] target (plan-gate): $GATE_BUNDLE"

MARKER3="GLADOS_PLAN_GATE_V2"
if grep -q "$MARKER3" "$GATE_BUNDLE"; then
  echo "[patch] plan-gate already applied ($MARKER3 present) — skipping"
  exit 0
fi

# Back up if not the same file as ALS bundle.
if [ "$GATE_BUNDLE" != "$BUNDLE" ]; then
  [ -f "$GATE_BUNDLE.pre-glados.bak" ] || cp "$GATE_BUNDLE" "$GATE_BUNDLE.pre-glados.bak"
fi

python3 - "$GATE_BUNDLE" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# Anchor at the very top of sessions_spawn execute body.
needle = (
    '\t\texecute: async (_toolCallId, args) => {\n'
    '\t\t\tconst params = args;\n'
    '\t\t\tconst unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find('
)
if needle not in src:
    legacy = '\t\t\t/* GLADOS_PLAN_GATE_V1 */\n'
    unsupported = '\t\t\tconst unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find('
    if legacy in src:
        start = src.index(legacy)
        end = src.index(unsupported, start)
        # Remove the legacy gate block, leaving the original unsupportedParam
        # anchor in place so the normal V2 insertion path can run.
        src = src[:start] + src[end:]
    else:
        sys.stderr.write("[patch] could not locate sessions_spawn execute body\n")
        sys.exit(2)

# Insert the gate immediately after `const params = args;` so we have access to
# args.agentId. We classify here using the global hook — sync, ~5ms cold path.
# If the hook is missing entirely, fail-closed for unknown/exploitation; allow
# meta/phase1 (matches the stub in tag-injector).
gate_block = (
    '\t\texecute: async (_toolCallId, args) => {\n'
    '\t\t\tconst params = args;\n'
    '\t\t\t/* GLADOS_PLAN_GATE_V2 */\n'
    '\t\t\ttry {\n'
    '\t\t\t\tconst _gladosTarget = (typeof params.agentId === "string" && params.agentId.trim()) || null;\n'
    '\t\t\t\tconst _gladosFallbackAllowed = (_a) => new Set(["glados","atlas","ai-specialist","report-writer","report-validator","webapp-validator","api-validator","poc-validator","postex-validator","ad-validator","c2-validator","phish-validator","osint","origin-ip","net-recon","webapp-recon","source-code","plan-synthesizer"]).has(_a);\n'
    '\t\t\t\tconst _gladosDeny = (_reason, _phase) => jsonResult({ ok: false, error: "GLADOS_PLAN_GATE_DENY", agent: _gladosTarget, reason: _reason || "denied", phase: _phase || "fallback" });\n'
    '\t\t\t\tif (typeof globalThis.__gladosPlanGate === "function") {\n'
    '\t\t\t\t\tif (_gladosTarget) {\n'
    '\t\t\t\t\t\tconst _gladosVerdict = globalThis.__gladosPlanGate(_gladosTarget);\n'
    '\t\t\t\t\t\tif (_gladosVerdict && _gladosVerdict.allowed === false) {\n'
    '\t\t\t\t\t\t\ttry { process.stderr.write(`[GLADOS_PLAN_GATE] DENY ${_gladosTarget}: ${_gladosVerdict.reason}\\n`); } catch(_){}\n'
    '\t\t\t\t\t\t\treturn jsonResult({ ok: false, error: "GLADOS_PLAN_GATE_DENY", agent: _gladosTarget, reason: _gladosVerdict.reason || "denied", phase: _gladosVerdict.phase || "unknown", plan_id: _gladosVerdict.plan_id, engagement_id: _gladosVerdict.engagement_id });\n'
    '\t\t\t\t\t\t}\n'
    '\t\t\t\t\t}\n'
    '\t\t\t\t} else if (_gladosTarget && !_gladosFallbackAllowed(_gladosTarget)) {\n'
    '\t\t\t\t\ttry { process.stderr.write(`[GLADOS_PLAN_GATE] missing hook; fail-closed ${_gladosTarget}\\n`); } catch(_){}\n'
    '\t\t\t\t\treturn _gladosDeny("plan-gate hook missing; refusing exploitation by default", "fallback");\n'
    '\t\t\t\t}\n'
    '\t\t\t} catch (_gladosErr) {\n'
    '\t\t\t\ttry { process.stderr.write(`[GLADOS_PLAN_GATE] hook error: ${_gladosErr && _gladosErr.message}\\n`); } catch(_){}\n'
    '\t\t\t\tconst _gladosTarget = (typeof params.agentId === "string" && params.agentId.trim()) || null;\n'
    '\t\t\t\tconst _gladosFallbackAllowed = (_a) => new Set(["glados","atlas","ai-specialist","report-writer","report-validator","webapp-validator","api-validator","poc-validator","postex-validator","ad-validator","c2-validator","phish-validator","osint","origin-ip","net-recon","webapp-recon","source-code","plan-synthesizer"]).has(_a);\n'
    '\t\t\t\tif (_gladosTarget && !_gladosFallbackAllowed(_gladosTarget)) return jsonResult({ ok: false, error: "GLADOS_PLAN_GATE_DENY", agent: _gladosTarget, reason: "plan-gate hook error; refusing exploitation by default", phase: "fallback" });\n'
    '\t\t\t}\n'
    '\t\t\tconst unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find('
)

out = src.replace(needle, gate_block, 1)
if out == src:
    sys.stderr.write("[patch] no substitution made for plan-gate\n")
    sys.exit(3)

with open(path, "w", encoding="utf-8") as f:
    f.write(out)

print("[patch] applied GLADOS_PLAN_GATE_V2")
PYEOF

node --check "$GATE_BUNDLE" && echo "[patch] plan-gate syntax ok"
