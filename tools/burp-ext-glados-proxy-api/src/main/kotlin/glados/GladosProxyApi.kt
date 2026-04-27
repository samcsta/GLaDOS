package glados

import burp.api.montoya.BurpExtension
import burp.api.montoya.MontoyaApi
import burp.api.montoya.proxy.http.InterceptedRequest
import burp.api.montoya.proxy.http.InterceptedResponse
import burp.api.montoya.proxy.http.ProxyRequestHandler
import burp.api.montoya.proxy.http.ProxyRequestReceivedAction
import burp.api.montoya.proxy.http.ProxyRequestToBeSentAction
import burp.api.montoya.proxy.http.ProxyResponseHandler
import burp.api.montoya.proxy.http.ProxyResponseReceivedAction
import burp.api.montoya.proxy.http.ProxyResponseToBeSentAction
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import fi.iki.elonen.NanoHTTPD
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * GLaDOS Burp Montoya extension.
 *
 * Exposes a local HTTP API on 127.0.0.1:1338 so the GLaDOS Ops Dashboard and
 * watchdog circuit breaker can read Burp proxy history — something the built-in
 * Burp REST API does not provide.
 *
 * Endpoints:
 *   GET  /health                  -> {"ok":true,"buffered":N}
 *   GET  /proxy/history           -> JSON array of the last N metadata entries
 *   GET  /proxy/history?since=ID  -> entries with id > ID (for incremental polling)
 *   GET  /proxy/history?limit=N   -> cap returned count (default 200, max 2000)
 *   GET  /proxy/rps?window=10     -> {"rps": float, "window": seconds}
 *   GET  /proxy/stream            -> Server-Sent Events, one entry per line as it
 *                                    lands in proxy history
 *   GET  /proxy/detail?id=N       -> Full request + response including headers and
 *                                    bodies (bodies capped to GLADOS_EXT_BODY_CAP bytes)
 *
 * Config via env (set on Burp process, or JVM system properties):
 *   GLADOS_EXT_PORT      (default 1338)
 *   GLADOS_EXT_BUFFER    (default 5000 — max entries kept in ring buffer)
 */
class GladosProxyApi : BurpExtension {
    private val mapper = ObjectMapper().registerKotlinModule()
    private val buffer = RingBuffer(
        capacity = (System.getenv("GLADOS_EXT_BUFFER") ?: "5000").toIntOrNull() ?: 5000
    )
    private val details = ConcurrentHashMap<Long, DetailEntry>()
    private val bodyCap: Int = (System.getenv("GLADOS_EXT_BODY_CAP") ?: "65536").toIntOrNull() ?: 65536
    private val nextId = AtomicLong(1)
    private val sseClients = ConcurrentHashMap.newKeySet<SseClient>()
    private var httpServer: ApiServer? = null
    private lateinit var api: MontoyaApi
    // v3.1: per-agent metrics — ring-buffer of recent samples per agent id.
    // Each sample is {ts, status}. RPS is windowed over `ts`; error rate is
    // share of samples where status >= 400. Latency histograms (p50/p95/p99)
    // tracked as a parallel ring of request durations when available.
    private val agentMetrics = ConcurrentHashMap<String, AgentRing>()

    override fun initialize(api: MontoyaApi) {
        this.api = api
        api.extension().setName("GLaDOS Proxy API")

        // Subscribe to proxy events. We record on responseReceived because
        // only then do we have both request and response info in one place.
        api.proxy().registerRequestHandler(object : ProxyRequestHandler {
            override fun handleRequestReceived(r: InterceptedRequest): ProxyRequestReceivedAction =
                ProxyRequestReceivedAction.continueWith(r)
            override fun handleRequestToBeSent(r: InterceptedRequest): ProxyRequestToBeSentAction =
                ProxyRequestToBeSentAction.continueWith(r)
        })
        api.proxy().registerResponseHandler(object : ProxyResponseHandler {
            override fun handleResponseReceived(r: InterceptedResponse): ProxyResponseReceivedAction {
                record(r)
                return ProxyResponseReceivedAction.continueWith(r)
            }
            override fun handleResponseToBeSent(r: InterceptedResponse): ProxyResponseToBeSentAction =
                ProxyResponseToBeSentAction.continueWith(r)
        })

        val port = (System.getenv("GLADOS_EXT_PORT") ?: "1338").toIntOrNull() ?: 1338
        httpServer = ApiServer(port).also {
            it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true)
            api.logging().logToOutput("[glados-proxy-api] listening on http://127.0.0.1:$port")
        }

        api.extension().registerUnloadingHandler {
            httpServer?.stop()
            sseClients.forEach { it.close() }
            api.logging().logToOutput("[glados-proxy-api] unloaded")
        }
    }

    private fun record(r: InterceptedResponse) {
        val req = r.initiatingRequest() ?: return
        val id = nextId.getAndIncrement()

        // v3.1 Tier 3 #12 — HMAC verification of X-GLaDOS-Agent-Signed.
        // When the signed header is present and the signature is valid (matches
        // the agent claimed in X-GLaDOS-Agent, within the replay window), we
        // tag as the claimed agent. When the signed header is present but the
        // signature is INVALID, we tag "(forged:<claimed>)" so operator can
        // see spoofing attempts in Burp history. When absent (legacy/non-scope
        // path), fall back to the plain header.
        val claimed = req.headerValue("X-GLaDOS-Agent") ?: ""
        val signedHeader = req.headerValue("X-GLaDOS-Agent-Signed") ?: ""
        val resolvedTag = resolveAgentTag(claimed, signedHeader)

        val entry = HistoryEntry(
            id = id,
            ts = System.currentTimeMillis(),
            method = req.method(),
            url = req.url(),
            host = req.httpService()?.host() ?: "",
            port = req.httpService()?.port() ?: 0,
            secure = req.httpService()?.secure() ?: false,
            status = r.statusCode().toInt(),
            mime = r.statedMimeType()?.name ?: "",
            reqLen = req.body()?.length() ?: 0,
            respLen = r.body()?.length() ?: 0,
            tool = "PROXY",
            userAgent = req.headerValue("User-Agent") ?: "",
            agentTag = resolvedTag
        )
        buffer.add(entry)

        // v3.1: per-agent metrics sample. Untagged requests ("gateway" / "")
        // still get a bucket so the dashboard can show "untagged" traffic.
        val agentKey = entry.agentTag.ifBlank { "(untagged)" }
        val ring = agentMetrics.computeIfAbsent(agentKey) { AgentRing() }
        ring.record(MetricSample(ts = entry.ts, status = entry.status))

        // Capture full headers + capped body for on-demand detail lookup.
        val reqHeaders = runCatching {
            req.headers().associate { h -> h.name() to h.value() }
        }.getOrDefault(emptyMap())
        val respHeaders = runCatching {
            r.headers().associate { h -> h.name() to h.value() }
        }.getOrDefault(emptyMap())
        val reqBody = req.body()?.let { cap(it.bytes, bodyCap) } ?: CappedBody("", false, 0)
        val respBody = r.body()?.let { cap(it.bytes, bodyCap) } ?: CappedBody("", false, 0)
        details[id] = DetailEntry(
            id = id,
            requestLine = "${req.method()} ${req.path()} ${req.httpVersion() ?: "HTTP/1.1"}",
            statusLine = "${r.httpVersion() ?: "HTTP/1.1"} ${r.statusCode()} ${r.reasonPhrase() ?: ""}",
            requestHeaders = reqHeaders,
            responseHeaders = respHeaders,
            requestBody = reqBody.text,
            requestBodyTruncated = reqBody.truncated,
            requestBodyLen = reqBody.origLen,
            responseBody = respBody.text,
            responseBodyTruncated = respBody.truncated,
            responseBodyLen = respBody.origLen
        )
        // Cap the details map at the same size as history buffer.
        if (details.size > buffer.size() + 100) {
            val cutoffId = id - (buffer.size() + 100)
            details.keys.removeAll { it < cutoffId }
        }

        val line = mapper.writeValueAsString(entry)
        val iter = sseClients.iterator()
        while (iter.hasNext()) {
            val c = iter.next()
            if (!c.send(line)) iter.remove()
        }
    }

    // v3.1 Tier 3 #12 — HMAC verification of X-GLaDOS-Agent-Signed.
    // Secret is loaded once from ~/.openclaw/glados-secret. If the file is
    // missing or shorter than 32 chars, signing is considered disabled on the
    // verifier side — we pass the claimed tag through unchanged (compat mode).
    private val hmacSecret: String? = runCatching {
        val f = java.io.File(System.getProperty("user.home"), ".openclaw/glados-secret")
        if (f.exists()) f.readText().trim().takeIf { it.length >= 32 } else null
    }.getOrNull()
    private val replayWindowMs: Long =
        (System.getenv("GLADOS_HMAC_WINDOW_MS") ?: "120000").toLongOrNull() ?: 120_000L

    // v3.1.04252026 (Blocker I) — Strict mode rejects plain claims when the
    // signed header is absent. Default is permissive (compat with rollouts
    // where the gateway hasn't restarted yet); operator opts in via
    // ~/.openclaw/glados-hmac-strict (presence-only sentinel) or
    // GLADOS_HMAC_STRICT=1. In strict mode, claimed-but-unsigned becomes
    // "(unsigned:<claimed>)" so it stands out in the Proxy tab and is easy
    // to query for during a rollout audit. The intent is for that tag to
    // disappear entirely once every gateway is on v3.1.04252026.
    private val hmacStrict: Boolean = run {
        val sentinel = java.io.File(System.getProperty("user.home"), ".openclaw/glados-hmac-strict")
        sentinel.exists() || System.getenv("GLADOS_HMAC_STRICT") == "1"
    }

    private fun resolveAgentTag(claimed: String, signed: String): String {
        // No claimed tag: untagged request (will become "(untagged)" downstream).
        if (claimed.isBlank()) return ""
        // Verifier disabled (no secret on disk): trust the plain header.
        val secret = hmacSecret ?: return claimed
        // Claimed-but-unsigned: in strict mode flag it so it doesn't blend in.
        if (signed.isBlank()) return if (hmacStrict) "(unsigned:$claimed)" else claimed
        // Format: "agent.ts_ms.hex_hmac"
        val parts = signed.split(".")
        if (parts.size != 3) return "(forged:$claimed)"
        val (sigAgent, sigTs, sigMac) = Triple(parts[0], parts[1].toLongOrNull(), parts[2])
        if (sigAgent != claimed || sigTs == null) return "(forged:$claimed)"
        val skew = kotlin.math.abs(System.currentTimeMillis() - sigTs)
        if (skew > replayWindowMs) return "(forged:$claimed)"
        val expected = runCatching {
            val mac = javax.crypto.Mac.getInstance("HmacSHA256")
            mac.init(javax.crypto.spec.SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            mac.doFinal("$claimed:$sigTs".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
        }.getOrDefault("")
        // Constant-time compare.
        if (expected.length != sigMac.length) return "(forged:$claimed)"
        var diff = 0
        for (i in expected.indices) diff = diff or (expected[i].code xor sigMac[i].code)
        return if (diff == 0) claimed else "(forged:$claimed)"
    }

    /** Cap a byte array to maxBytes, best-effort UTF-8 decode. */
    private fun cap(bytes: ByteArray, maxBytes: Int): CappedBody {
        val truncated = bytes.size > maxBytes
        val slice = if (truncated) bytes.copyOf(maxBytes) else bytes
        val text = try { slice.toString(Charsets.UTF_8) } catch (_: Exception) {
            // Fallback: hex preview for binary bodies.
            slice.joinToString("") { "%02x".format(it) }
        }
        return CappedBody(text = text, truncated = truncated, origLen = bytes.size)
    }

    private inner class ApiServer(port: Int) : NanoHTTPD("127.0.0.1", port) {
        override fun serve(session: IHTTPSession): Response {
            val uri = session.uri
            val params = session.parameters
            return when {
                uri == "/health" -> json(mapOf(
                    "ok" to true,
                    "buffered" to buffer.size(),
                    "hmac" to mapOf(
                        "secretLoaded" to (hmacSecret != null),
                        "strict" to hmacStrict,
                        "replayWindowMs" to replayWindowMs
                    )
                ))

                uri == "/proxy/history" -> {
                    val since = (params["since"]?.firstOrNull() ?: "0").toLongOrNull() ?: 0L
                    val limit = ((params["limit"]?.firstOrNull() ?: "200").toIntOrNull() ?: 200).coerceIn(1, 2000)
                    val rows = buffer.snapshot().asReversed()
                        .filter { it.id > since }
                        .take(limit)
                        .reversed()
                    json(rows)
                }

                uri == "/proxy/detail" -> {
                    val id = (params["id"]?.firstOrNull() ?: "").toLongOrNull()
                    val d = id?.let { details[it] }
                    if (d == null) newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", """{"error":"not found"}""")
                    else json(d)
                }

                uri == "/proxy/rps" -> {
                    val window = ((params["window"]?.firstOrNull() ?: "10").toIntOrNull() ?: 10).coerceIn(1, 600)
                    val cutoff = System.currentTimeMillis() - window * 1000L
                    val count = buffer.snapshot().count { it.ts >= cutoff }
                    json(mapOf("rps" to count.toDouble() / window, "window" to window, "count" to count))
                }

                uri == "/proxy/metrics" -> {
                    // v3.1 — per-agent metrics. Windowed RPS + error rate +
                    // request count over the last N seconds.
                    val window = ((params["window"]?.firstOrNull() ?: "10").toIntOrNull() ?: 10).coerceIn(1, 600)
                    val now = System.currentTimeMillis()
                    val cutoff = now - window * 1000L
                    val out = agentMetrics.entries.map { (agent, ring) ->
                        val samples = ring.snapshotSince(cutoff)
                        val total = samples.size
                        val errors = samples.count { it.status >= 400 }
                        val status5xx = samples.count { it.status in 500..599 }
                        val status4xx = samples.count { it.status in 400..499 }
                        val rps = total.toDouble() / window
                        val errorRate = if (total > 0) errors.toDouble() / total else 0.0
                        AgentMetrics(
                            agent = agent,
                            requests = total,
                            rps = rps,
                            errorRate = errorRate,
                            status4xx = status4xx,
                            status5xx = status5xx,
                            lastTs = samples.lastOrNull()?.ts ?: 0L
                        )
                    }.sortedByDescending { it.rps }
                    json(mapOf("window" to window, "ts" to now, "agents" to out))
                }

                uri == "/proxy/stream" -> {
                    // Server-Sent Events. NanoHTTPD streams via ChunkedResponse;
                    // we install a client that pushes future entries.
                    val pipe = SseClient()
                    sseClients.add(pipe)
                    newChunkedResponse(Response.Status.OK, "text/event-stream", pipe.inputStream).apply {
                        addHeader("Cache-Control", "no-cache")
                        addHeader("Connection", "keep-alive")
                        addHeader("Access-Control-Allow-Origin", "*")
                    }
                }

                else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found: $uri")
            }
        }

        private fun json(obj: Any): Response =
            newFixedLengthResponse(Response.Status.OK, "application/json", mapper.writeValueAsString(obj)).apply {
                addHeader("Access-Control-Allow-Origin", "*")
            }
    }
}

/** Full request + response with headers and capped bodies, on-demand lookup. */
data class DetailEntry(
    val id: Long,
    val requestLine: String,
    val statusLine: String,
    val requestHeaders: Map<String, String>,
    val responseHeaders: Map<String, String>,
    val requestBody: String,
    val requestBodyTruncated: Boolean,
    val requestBodyLen: Int,
    val responseBody: String,
    val responseBodyTruncated: Boolean,
    val responseBodyLen: Int
)

/** Capped body payload used internally before wrapping in DetailEntry. */
private data class CappedBody(val text: String, val truncated: Boolean, val origLen: Int)

/** One proxy history entry. Flat shape so the dashboard table can bind 1:1. */
data class HistoryEntry(
    val id: Long,
    val ts: Long,
    val method: String,
    val url: String,
    val host: String,
    val port: Int,
    val secure: Boolean,
    val status: Int,
    val mime: String,
    val reqLen: Int,
    val respLen: Int,
    val tool: String,
    val userAgent: String,
    val agentTag: String
)

/**
 * Simple bounded ring buffer. Drops oldest when full. Read-heavy (the dashboard
 * polls), so reads use a shared lock; writes take the exclusive lock.
 */
class RingBuffer(private val capacity: Int) {
    private val lock = ReentrantReadWriteLock()
    private val data = ArrayDeque<HistoryEntry>(capacity)

    fun add(e: HistoryEntry) = lock.write {
        if (data.size >= capacity) data.removeFirst()
        data.addLast(e)
    }
    fun snapshot(): List<HistoryEntry> = lock.read { data.toList() }
    fun size(): Int = lock.read { data.size }
}

/**
 * v3.1 — Per-agent metric sample. `ts` is epoch millis of the response;
 * `status` is the HTTP status code.
 */
data class MetricSample(val ts: Long, val status: Int)

/**
 * v3.1 — Aggregated per-agent metrics over a rolling window (emitted via
 * /proxy/metrics). The dashboard renders one sparkline card per agent.
 */
data class AgentMetrics(
    val agent: String,
    val requests: Int,
    val rps: Double,
    val errorRate: Double,
    val status4xx: Int,
    val status5xx: Int,
    val lastTs: Long
)

/**
 * v3.1 — Bounded ring of metric samples per agent. Caps out at 2000 samples
 * to bound heap; that's enough for 5-minute windows at 6 RPS sustained.
 */
class AgentRing(private val capacity: Int = 2000) {
    private val lock = ReentrantReadWriteLock()
    private val data = ArrayDeque<MetricSample>(capacity)

    fun record(s: MetricSample) = lock.write {
        if (data.size >= capacity) data.removeFirst()
        data.addLast(s)
    }

    fun snapshotSince(cutoff: Long): List<MetricSample> = lock.read {
        data.filter { it.ts >= cutoff }
    }
}

/**
 * SSE pump — writes to a pipe, Burp's NanoHTTPD serves from the read end.
 * Returns false from send() once the client disconnected.
 */
class SseClient {
    private val pipeOut = java.io.PipedOutputStream()
    val inputStream: java.io.PipedInputStream = java.io.PipedInputStream(pipeOut, 64 * 1024)
    private val writer = java.io.PrintWriter(pipeOut, true, Charsets.UTF_8)
    private var closed = false

    init {
        // Initial comment keeps the connection open on some proxies.
        writer.print(": glados-proxy-api stream open\n\n")
        writer.flush()
    }

    @Synchronized
    fun send(jsonLine: String): Boolean {
        if (closed) return false
        return try {
            writer.print("data: $jsonLine\n\n")
            writer.flush()
            !writer.checkError()
        } catch (_: Exception) {
            close(); false
        }
    }

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        try { writer.close() } catch (_: Exception) {}
        try { pipeOut.close() } catch (_: Exception) {}
    }
}
