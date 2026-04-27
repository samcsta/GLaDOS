# GLaDOS v3.1.04242026 Flow Diagrams

This document shows how a v3.1 web application assessment is supposed to move
through GLaDOS, and how the local pieces connect. Status markers:

- `[OK]` implemented and wired in the current tree.
- `[SOFT]` documented or prompt-enforced, but not a hard technical gate.
- `[FIX]` present but broken, missing from active config, or incomplete.
- `[TODO]` planned v3.1/Tier 2+ work not implemented yet.

## Web App Assessment Flow: `example.com`

```mermaid
flowchart TD
  A["Operator enters target: https://example.com"] --> B["GLaDOS intake"]
  B --> C["RoE/scope check [SOFT]"]
  C --> D["watchdog_mcp.target_probe(example.com) [OK]"]
  D --> E{"target_health == healthy?"}
  E -- "No" --> E1["Refuse dispatch / wait / re-probe later [OK]"]
  E -- "Yes" --> F["Create/read engagement state in blackboard [FIX]"]

  F --> G["Phase 1: Baseline Recon [SOFT]"]
  G --> G1["DradisTab prior-report lookup via Browser MCP [SOFT]"]
  G --> G2["DNS + TLS fingerprint [SOFT]"]
  G --> G3["Dispatch osint, 10 min cap [SOFT]"]
  G3 --> G4{"CDN/WAF or load balancer likely?"}
  G4 -- "Yes" --> G5["Dispatch origin-ip first [SOFT]"]
  G4 -- "No / low confidence" --> G6["Dispatch net-recon if allowed [SOFT]"]
  G5 --> G7["Dispatch webapp-recon for structured browser map [SOFT]"]
  G6 --> G7
  G7 --> G8["Write baseline.summary with recon.complete=true [FIX]"]

  G8 --> H["Phase 2: plan-synthesizer reads baseline [OK/SOFT]"]
  H --> I["POST /api/plans creates pending_approval plan [OK]"]
  I --> J["Dashboard Plans tab shows vectors and agent chain [OK]"]
  J --> K{"Operator decision"}
  K -- "Reject" --> K1["Plan rejected with reason [OK]"]
  K1 --> G
  K -- "Modify" --> K2["Child plan supersedes parent [OK]"]
  K2 --> J
  K -- "Approve all/selected" --> L["Plan state = approved [OK]"]

  L --> L1["Generate per-agent fetch ACL [TODO]"]
  L --> M["Phase 3: dispatch approved execution agents [SOFT]"]
  M --> M1["webapp-vuln / api-expert / poc-coder etc. [SOFT]"]
  M1 --> N["Traffic forced/tagged through Burp when patch active [OK]"]
  N --> O["Burp extension records history + per-agent metrics [OK]"]
  O --> P["Dashboard Proxy tab shows rows, detail, sort, replay [PARTIAL]"]
  M1 --> Q["Agents write findings/evidence to blackboard [FIX]"]
  Q --> R["Validator agent independently verifies finding [SOFT]"]
  R --> S{"confidence >= 0.9 and CWE in cwe-cascade?"}
  S -- "Yes" --> S1["Halt remaining chain and propose replan [SOFT]"]
  S1 --> H
  S -- "No" --> T["Continue approved chain [SOFT]"]
  T --> U["report-writer + report-validator after operator approval [SOFT]"]
  U --> V["Final CWE files / Dradis handoff [SOFT]"]

  O --> W{"Circuit breaker sees 3x 5xx/429 in 60s?"}
  W -- "Yes" --> W1["engagement_halt_all + mark target down [OK/PARTIAL]"]
  W -- "No" --> T
  W1 --> W2["Burp gate halt-all [PARTIAL]"]
  W1 --> W3["All-agent deny rules [FIX]"]

  classDef ok fill:#143d2a,stroke:#49b878,color:#f4fff8;
  classDef soft fill:#3f3417,stroke:#d4a93f,color:#fff8e3;
  classDef fix fill:#4a1f22,stroke:#e06e6e,color:#fff5f5;
  classDef todo fill:#273349,stroke:#7fa7ff,color:#f4f8ff;
  class D,I,J,L,N,O ok;
  class C,G,G1,G2,G3,G5,G6,G7,H,M,M1,R,S1,T,U,V soft;
  class F,G8,Q,W3 fix;
  class L1 todo;
```

## System Wiring And Interaction Map

```mermaid
flowchart LR
  subgraph OperatorSurface["Operator Surface"]
    UI["Dashboard UI :4280 [OK]"]
    Chat["GLaDOS / Atlas chat panes [OK]"]
    ProxyTab["Proxy tab [PARTIAL]"]
    PlansTab["Plans tab [OK]"]
    ReportsTab["Reports tab [OK]"]
    HealthBanner["Health banner [OK]"]
    Terminal["Web terminal [OK]"]
  end

  subgraph Dashboard["dashboard/server.js"]
    Express["Express REST + static UI [OK]"]
    Watcher["AgentWatcher tails session JSONL [OK]"]
    RawTail["RawStreamTail tails token stream [OK]"]
    PlansApi["/api/plans router [OK]"]
    ProxyApi["/api/proxy passthrough + replay [OK/PARTIAL]"]
    HaltApi["/api/halt + /api/halt-all [OK/PARTIAL]"]
    ReportsApi["/api/reports [OK]"]
  end

  subgraph OpenClaw["OpenClaw Runtime"]
    Config["~/.openclaw/openclaw.json [OK/PARTIAL]"]
    Agents["Named agents: glados, osint, webapp-vuln, etc. [OK]"]
    Sessions["~/.openclaw/agents/*/sessions/*.jsonl [OK]"]
    Gateway["OpenClaw gateway / raw stream log [OK]"]
    ExecApprovals["~/.openclaw/exec-approvals.json [OK]"]
  end

  subgraph MCP["MCP Servers"]
    WatchdogMcp["watchdog_mcp registered [OK]"]
    ComputerUse["computer-use registered [OK]"]
    BlackboardMcp["blackboard_mcp server exists, not registered [FIX]"]
    BurpMcp["burp_mcp referenced in docs, not present/registered [FIX]"]
  end

  subgraph State["Local State"]
    BlackboardDb["blackboard.db: engagements/findings/tasks/plans [OK/PARTIAL]"]
    WatchdogDb["watchdog.db: target_health/halt_log/breaker [OK]"]
    Investigations["workspaces/glados/investigations/* [OK]"]
    PlanFiles["webapp playbook + cwe-cascade + plan-synthesizer [OK]"]
    FetchAcl["~/.openclaw/glados-fetch-acl.json [TODO]"]
    Secret["~/.openclaw/glados-secret HMAC [TODO]"]
  end

  subgraph Burp["Burp Layer"]
    BurpProxy["Burp proxy :8080 [external]"]
    BurpRest["Burp REST :1337 [PARTIAL]"]
    BurpExt["GLaDOS Montoya extension :1338 [OK]"]
    ResourcePool["Burp resource pool/rate cap [MANUAL]"]
  end

  subgraph PatchLayer["OpenClaw Patch / Tag Layer"]
    TagInjector["tools/tag-injector.js preload [OK]"]
    PatchScript["patch-openclaw-bundle.sh [OK]"]
    AlsPatch["GLADOS_ALS_PATCH_V1 marker [OK if patched]"]
    SsrfPatch["GLADOS_SSRF_ROUTE_V1 marker [OK if patched]"]
    SignedHeader["X-GLaDOS-Agent-Signed HMAC [TODO]"]
  end

  UI --> Express
  Chat --> Express
  ProxyTab --> ProxyApi
  PlansTab --> PlansApi
  ReportsTab --> ReportsApi
  HealthBanner --> Express
  Terminal --> Express

  Express --> Watcher
  Express --> RawTail
  Watcher --> Sessions
  RawTail --> Gateway
  Express --> Agents
  Express --> ReportsApi
  ReportsApi --> Investigations

  Config --> Agents
  Config --> WatchdogMcp
  Config --> ComputerUse
  Config -. missing .-> BlackboardMcp
  Config -. missing .-> BurpMcp

  Agents --> WatchdogMcp
  Agents -. expected .-> BlackboardMcp
  WatchdogMcp --> WatchdogDb
  BlackboardMcp --> BlackboardDb
  PlansApi --> BlackboardDb

  Agents --> TagInjector
  TagInjector --> BurpProxy
  PatchScript --> AlsPatch
  PatchScript --> SsrfPatch
  AlsPatch --> TagInjector
  SsrfPatch --> TagInjector
  TagInjector -. not yet .-> SignedHeader
  TagInjector -. not yet .-> FetchAcl

  BurpProxy --> BurpExt
  BurpExt --> ProxyApi
  BurpRest --> HaltApi
  HaltApi --> ExecApprovals
  HaltApi --> WatchdogDb
  HaltApi --> BurpRest
  BurpExt --> WatchdogDb
  WatchdogDb --> HealthBanner

  PlanFiles --> Agents
  PlanFiles --> PlansApi
  FetchAcl -. should constrain .-> Agents
  Secret -. should verify .-> SignedHeader

  classDef ok fill:#143d2a,stroke:#49b878,color:#f4fff8;
  classDef partial fill:#3f3417,stroke:#d4a93f,color:#fff8e3;
  classDef fix fill:#4a1f22,stroke:#e06e6e,color:#fff5f5;
  classDef todo fill:#273349,stroke:#7fa7ff,color:#f4f8ff;
  class UI,Chat,PlansTab,ReportsTab,HealthBanner,Terminal,Express,Watcher,RawTail,PlansApi,ReportsApi,Agents,Sessions,Gateway,ExecApprovals,WatchdogMcp,ComputerUse,WatchdogDb,Investigations,PlanFiles,BurpExt,TagInjector,PatchScript,AlsPatch,SsrfPatch ok;
  class ProxyTab,ProxyApi,Config,BlackboardDb,BurpRest,HaltApi partial;
  class BlackboardMcp,BurpMcp fix;
  class FetchAcl,Secret,SignedHeader todo;
```

## What Needs Fixing Before v3.1 Feels Coherent

| Priority | Component | Current state | Fix |
|---|---|---|---|
| P0 | `blackboard_mcp` | Server exists, docs require it, but active `~/.openclaw/openclaw.json` does not register it. | Add it to `mcp.servers`, restart gateway, verify tools appear to agents. |
| P0 | Hard plan gate | Phase invariants are in `SOUL.md`, but dispatch blocking is model/prompt-enforced. | Add a technical `plan_check_dispatch` gate or OpenClaw hook before network-capable agent dispatch. |
| P0 | Halt-all | `engagement_halt_all` flips Burp gate and logs, but does not add deny rules for every agent. | On halt-all, enumerate registered agents and add deny rules for all network tools. |
| P1 | Blackboard task dispatch | `blackboard_task_create` only inserts a row; nothing consumes it. | Rename docs to "audit task" or implement a task dispatcher. |
| P1 | Fetch ACL | Planned but absent; approved plans do not generate `glados-fetch-acl.json`. | Generate ACL on plan approval and enforce it in the SSRF/fetch patch. |
| P1 | HMAC agent header | Planned but absent; `X-GLaDOS-Agent` remains forgeable by local callers. | Add `glados-secret`, signed header emission, and verification in the Burp extension. |
| P1 | Burp MCP | Docs reference `burp_mcp`, but current integration is dashboard REST plus Burp extension. | Either implement/register Burp MCP or update docs to call it the dashboard/Burp extension API. |
| P2 | Proxy Tier 2 UI | Sort and search inputs are present; replay endpoint exists. Modal/search behavior still needs verification/completion. | Finish replay modal, search highlighting/counts, and browser smoke test. |
| P2 | Getting Started Tier 2 | Current tab is mostly prose; health banner exists. | Add localStorage checklists, validation buttons, copy buttons, and deep links. |
| P2 | Specialist tool docs | Many agent `TOOLS.md` files are still generic templates. | Replace with role-specific allowed tools, output schemas, and evidence rules. |

## Recommended Next Step

Make v3.1 reliable before adding more features:

1. Register `blackboard_mcp` in `~/.openclaw/openclaw.json`.
2. Implement a hard `plan_check_dispatch` MCP/tool gate.
3. Strengthen `engagement_halt_all` to deny all network-capable tools for all agents.
4. Finish and browser-test the partially implemented Proxy Tier 2 UX.

