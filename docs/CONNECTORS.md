# GLaDOS connectors

**Tools → Connectors** manages Clippy and the MCP connections available to agent
packages. Built-in Blackboard, Watchdog, GLaDOS tools, and Browser entries show
their provided tools. Clippy appears in **Your connectors** as an optional
knowledge integration with its existing read-only tool selection.

**Add connector** opens the Available/Connected catalog. Select **Clippy →
Connect**, paste your API key, and connect. GLaDOS checks the key before saving
it locally; saved keys are never displayed. Connecting asks separately whether
to **Create Clippy Agent**. Choose **Not now** to browse findings and repositories
without creating an agent. Existing agents and their edits are reused. New lookups and agent turns use the
connection without restarting the app. Built-in connectors cannot be
disconnected. **Disconnect** on Clippy or another optional connector removes its
saved credential and stops mounting it for agent use, while keeping conversation
history and the connector's public configuration.

Advanced HTTP, SSE, and local stdio MCP configurations remain available through
**Import MCP config**:

```json
{
  "mcpServers": {
    "my-connector": {
      "url": "https://server.example/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

Imports preview the connections and local commands before saving. Imported
connections start disabled. **Check connection** initializes the MCP session and
lists its tools; it does not call those tools. Checking a disabled connection
without a tool selection records the advertised names for review. Enable it
after reviewing its tools. Later checks do not broaden an enabled tool selection.

A local connector uses an installed executable, a JSON argument list, and
optional environment variables. Saving/importing a configuration does not start
the command or install its dependencies. Checking or invoking it starts the
configured process. `${VARIABLE_NAME}` references resolve from the app's
environment when the connection is used.

Custom connections are stored separately from the application under
`~/.glados/connectors`. Credentials, full endpoint URLs, and local argument
payloads are stored in owner-only files under `~/.glados/secrets/connectors`.
Headers, environment values, URL query values, and recognized authentication
arguments are hidden in the dashboard. Leaving credential fields blank while
editing keeps their saved values. Use headers or environment variables for
credentials rather than arbitrary positional arguments.

The agent editor selects connectors as dependencies and selects tools as
capabilities. Selecting a connector alone does not grant every tool it provides.
An explicitly selected server mount expands only to its configured tool list.
Unavailable required connectors block invocation, while normal scope, plan,
health, halt, and permission checks remain in force. User connector tools require
the agent's exact scoped identity in an approved plan and an in-scope target.

Connector edits require the revision that was loaded. Importing an existing
identity reports a conflict instead of replacing it. Removing a custom connector
archives a disabled record; it does not erase its private files. Application
updates preserve the collection and credentials of connected integrations.

## Assessment browser and Proxy

In an assessment session, **Tools → Proxy → Agent browser → Open browser** opens
the actual headed Chrome/Chromium browser controlled by that agent's Playwright
MCP tools. Manual browsing and agent actions use the same tabs, cookies and login
state. Each session and agent has a separate private profile. Returning to the
same browser reuses it; ending a chat turn disconnects MCP without closing the
operator's browser. Closing GLaDOS stops the browsers it owns.

Traffic goes through the session's dedicated listener, including loopback
destinations. HTTPS inspection accepts only the current local GLaDOS CA in this
browser; upstream certificate verification remains enabled. Chrome/Chromium must
be installed. A missing executable produces an installation message instead of
opening a substitute Electron browser. Custom Browser MCP commands keep their
configuration and are explicitly identified as separate from managed browsers.

The picker lists only enabled agents with Browser tools in the session's team.
A read-only Clippy conversation does not grant browser tools. Use a GLaDOS
assessment session or assign Browser capabilities to the appropriate team agent.

## Clippy workspace

**Tools → Clippy** opens a conversation workspace with a small **Ready to
investigate** shortlist. Chat has the main workspace; **Focus chat** expands it.
**Browse evidence** opens findings, engagement repositories, and optional local
cache maintenance separately. Findings default to **Live Clippy**, which queries
connected Clippy even when a partial local cache exists. The **Source** selector
offers **Local cache** for browsing the accumulated inventory. Engagement repo
lists, file lists, and source reads use connected Clippy independently of local
cache progress. The conversation keeps its own history and does not change the
active assessment.
Creating or enabling Clippy Agent requires an explicit confirmation; merely
connecting or opening the Clippy tab does not create or enable it.
**Ask Clippy** stages a question for review before sending it. The inline
**Edit agent** action opens Clippy in **Tools → Agents**, where its instructions,
model, reasoning, deliverables, and selected read-only Clippy tools can be edited.
Saved edits survive source seeding and app updates. The agent can query all 22
approved read-only Clippy tools directly, including domain, infrastructure,
GitHub, assessment, and directory sources. It is not limited to the local cache.
Existing exact legacy six-tool selections migrate; deliberately narrower tool
selections stay unchanged.

Clippy source citations open an internal source viewer, including older saved
citations that contain a previous localhost port. The viewer reads the exact
Clippy repo/path and pages through 200 lines at a time. New agent answers use
`/api/clippy/file?repo=<repo>&path=<full-path>#L<line>` links. Cited finding files
from a newly completed Clippy turn are checked in a bounded import and staged
under **Evidence to review**; replaying chat history does not trigger retrieval.
Source-code candidates can identify an exact canonical repository and immutable
assessed commit without inventing a deployed domain. Their cards label deployment
and current exploitability as unverified. An empty ready shortlist expands the
review collection so supported candidates remain useful.

**Find leads** runs a focused source search, stopping after 36 lookups, 18
documents, eight candidates, or one minute. It does not start global indexing.
Candidates need an explicit target URL, critical/high source severity, and
reproduction evidence; sources marked fixed/resolved are excluded. Each card
shows the hypothesis, next scoped verification, evidence references, and
report-check provenance. These are historical leads, not claims of current
exploitability. The shortlist contains at most five verified leads.

Clippy's cached Dradis project search lacks a complete target-to-report mapping.
Neither an empty search nor its capped result count establishes report absence.
Possible report matches and unverified candidates stay under **Withheld from
recommendations**. Delivered, Closed, Draft, and Review status variants count as
possible report evidence. Any matching project prevents automatic promotion.

**Record Dradis check** records an analyst's direct check of the exact target,
aliases, related projects, and reports, with a Dradis HTTPS source URL and notes.
For source review the scope is the canonical repository and assessed commit.
GLaDOS refreshes source evidence and possible project matches before accepting
the receipt. Every possible name match needs an explicit tied, unrelated, or
unknown relationship and notes; only all unrelated matches plus an explicit
no-tied-report confirmation can produce a ready receipt. A confirmed tied report
remains excluded even if a later cached search omits it. New evidence, changed
match sets, and concurrent checks invalidate an older pending verification.
This is an
attributed analyst attestation, not an automated proof of absence. It expires
after 24 hours; changed source evidence, lookup errors, or new possible report
matches withhold a refreshed candidate again. Recheck coverage before starting
assessment work. Saved lead metadata and receipts are local, owner-readable,
and bound to the connected account; API keys and source document bodies are
not stored in this collection.

DradisTab exposes a read-only `/api/projects` inventory with project identifiers,
status, report-stage dates, EAMS/ERT values, and evidence labels. The inspected
response does not contain finding/issue records or a target-scope mapping. That
project feed, whether accessed through Clippy or a future Dradis MCP, cannot by
itself establish an exact finding-to-report relationship. An automatic report
check needs authorized report and scope records, complete pagination and an
explicit coverage boundary. The verification dialog links to the existing
DradisTab filter as a starting point for a direct analyst check.
Dradis Pro also has an [official REST API](https://dradis.com/support/guides/rest_api/)
for projects, nodes, issues and evidence. A future read-only MCP can use authorized
API access to those resources rather than scrape the UI; it must make its allowed
project scope and pagination coverage explicit. This integration does not create
an API credential or assume the current operator can read every project.

Clippy's MCP search returns at most 100 matches per query without a page cursor.
Live findings counts describe the parsed matches from that query, not the full
Clippy inventory; refine the search or select a repo to explore other results.
Category and severity counts apply only to the parsed matches. The agent can
query the other intelligence tools and read known source paths as needed, within
the saved tool selection and the connected key's permissions. Having access to
these tools does not mean every Clippy record has been loaded into a conversation.

Under
**Browse evidence → Local cache**, select **Index intelligence** to build an
optional local inventory across search partitions and
engagement repositories. Each run makes at most 100 lookup calls, can be paused,
and resumes from its progress. Findings pagination then covers the accumulated
inventory beyond 100 results when **Source → Local cache** is selected. A label
such as **191/6,067 parsed · 5,876 not parsed** means 6,067 finding paths were
discovered locally and 191 headers were parsed; it does not limit Clippy Agent's
direct MCP access. A filtered match count describes only this local result set.
Severity, text, category, and repo filters apply to the loaded metadata. Missing
severity stays unspecified. Discovery and
metadata coverage remain labeled incomplete until all available finding files
have been loaded; Clippy's 500-file repo limit and unreadable files prevent a
complete coverage claim. Metadata is stored locally in an owner-only file bound
to the connected account, without API keys or full document bodies.

The legacy inventory coverage API searches Clippy's cached Dradis project feed
and shows matched projects, status, feed age, and
lookup time. A project record alone does not establish a delivered report, and a
missing text match does not establish that no live Dradis report exists. Verify
the linked project's target scope and report before acting. Historical leads
and retrieved content do not authorize target testing.
