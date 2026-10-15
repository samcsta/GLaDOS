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

## Clippy workspace

**Tools → Clippy** contains **Where to start**, **Security findings**, and
**Engagement repos**, alongside an inline **Clippy Agent** conversation. This
conversation keeps its own history and does not change the active assessment.
Creating or enabling Clippy Agent requires an explicit confirmation; merely
connecting or opening the Clippy tab does not create or enable it.
**Ask Clippy** stages a question for review before sending it. The inline
**Edit agent** action opens Clippy in **Tools → Agents**, where its instructions,
model, reasoning, deliverables, and selected read-only Clippy tools can be edited.
Saved edits survive source seeding and app updates.

Clippy's MCP search returns at most 100 matches without a page cursor. Select
**Index intelligence** to build a local inventory across search partitions and
engagement repositories. Each run makes at most 100 lookup calls, can be paused,
and resumes from its progress. Findings pagination then covers the accumulated
inventory beyond 100 results. Severity, text, category, and repo filters apply
to the loaded metadata. Missing severity stays unspecified. Discovery and
metadata coverage remain labeled incomplete until all available finding files
have been loaded; Clippy's 500-file repo limit and unreadable files prevent a
complete coverage claim. Metadata is stored locally in an owner-only file bound
to the connected account, without API keys or full document bodies.

**Where to start** ranks domains by critical and high finding counts, using
explicit target metadata from finding documents. Findings without a target stay
available in Security findings. **Check report coverage** searches Clippy's
cached Dradis project feed and shows the matched projects, status, feed age, and
lookup time. A project record alone does not establish a delivered report, and a
missing text match does not establish that no live Dradis report exists. Verify
the linked project's target scope and report before acting. Historical leads
and retrieved content do not authorize target testing.
