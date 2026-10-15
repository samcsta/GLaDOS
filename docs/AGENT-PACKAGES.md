# GLaDOS agent packages

An agent package describes one or more specialists, optional teams, skills, and
supporting text resources. Packages select capabilities from GLaDOS; they do not
install MCP servers, credentials, arbitrary agent frameworks, or dependencies.
Connector setup belongs in **Tools → Connectors**.

The public uploader accepts individual agent packages, including instruction
Markdown and folders. It rejects team manifests. Create custom teams in Agents,
or have Codex integrate an existing team into the GLaDOS source collection.

Built-in agents ship in the application. Created and imported packages are kept
under `~/.glados/agent-packages` (or `GLADOS_RUNTIME_DIR/agent-packages`). Replacing
the application does not replace this user collection.

## Portable format

Export creates a UTF-8 `<id>-<version>.glados-agent.json` file. The following
example defines the format; GLaDOS does not install this sample automatically.

```json
{
  "schemaVersion": 1,
  "id": "my-specialists",
  "version": "1.0.0",
  "name": "My specialists",
  "description": "A privately maintained specialist collection.",
  "agents": [
    {
      "id": "specialist",
      "name": "My specialist",
      "description": "Describe which tasks this specialist handles.",
      "instructions": "Read the assigned material and produce the requested deliverable.",
      "model": null,
      "effort": "high",
      "enabled": true,
      "connectors": [],
      "requiredConnectors": [],
      "tools": ["Read", "Grep"],
      "deliverables": ["An evidence-based report"],
      "skills": [
        {
          "id": "checklist",
          "name": "Checklist",
          "description": "Follow the collection's review checklist.",
          "path": "skills/checklist/SKILL.md"
        }
      ]
    }
  ],
  "teams": [],
  "resources": [
    {
      "path": "skills/checklist/SKILL.md",
      "text": "# Checklist\nDescribe the checklist steps here.\n"
    }
  ]
}
```

Package, agent, team, and skill IDs are lowercase identifiers with hyphens, begin
with a letter, and are at most 64 characters. Versions use semantic versioning
without a `v` prefix. A package cannot use a built-in agent's identity.
GLaDOS gives an imported specialist the runtime ID `pkg-<package-id>--<agent-id>`
so packages can reuse local agent names without overwriting one another.

An agent requires nonempty instructions. `model: null` uses the configured model
default. Effort supports `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Connectors and tools name existing GLaDOS capabilities; selecting them
does not create or authorize a new external integration. When omitted,
`requiredConnectors` defaults to the selected connectors. An explicit list must
be a subset of `connectors`.

Skills may use the object format above, inline `instructions`, or a string ID
that refers to `skills/<id>/SKILL.md`. Inline instructions and an embedded
resource at the same path must match. Export retains both skill instructions
and supporting resources.

## Teams

Add a team with an identity distinct from its member agents:

```json
{
  "id": "my-team",
  "name": "My team",
  "description": "Describe the combined task.",
  "instructions": "Describe how members should work together.",
  "members": ["specialist", "another-specialist"],
  "coordinator": "specialist",
  "enabled": true
}
```

All members must be agents in the same package. The coordinator must be a member;
if omitted, the first member coordinates. GLaDOS exposes the team as a distinct
entry and lets its coordinator delegate to the package's listed members. Team
members remain separately identifiable during execution. The coordinator keeps
its selected capabilities; a member's connectors do not automatically grant the
coordinator access to those tools.

## Session teams and assignments

Choose **GLaDOS** or an enabled saved custom team on the blank new-session page.
The first message creates a session with that team identity. The saved conversation
keeps that choice when reopened; older conversations use GLaDOS by default.
GLaDOS's team includes its built-in specialists. A custom team's base roster
includes its own enabled package members.

Use the team assignment editor in Agents to add specific specialists to a team.
GLaDOS can use a custom specialist only after it has been explicitly assigned.
A custom team can receive built-in specialists or individual specialists from
another package. Reusing one specialist does not import the other team's
coordinator or remaining members. Assignments live separately in the owner-only
`~/.glados/agent-teams/collection.json` file and survive application updates.
Assignment revisions retain prior selections and reject stale edits. Finish or
stop a team's active work before changing its roster.

The session's chat, agent list, direct specialist messages, and resume actions
use only that selected roster. Built-in investigation commands require a GLaDOS
team session. If a selected team is deleted or disabled, the old conversation
remains readable and further work requires a new session with an available team.

An enabled custom specialist also has **Open conversation**, which starts a
direct conversation without a team assignment. Its session identity is
`agent:<runtime-id>` and its roster contains only that specialist. Direct
conversations cannot dispatch other agents, and reopening one preserves its
specialist identity.

## Integrated teams maintained in source

Codex can add a portable team package to
`templates/integrated-teams/<stable-name>.glados-agent.json`. This collection is
included in desktop builds. At startup, GLaDOS validates the source packages and
seeds them into the durable user collection using the trusted integration API;
there is no public HTTP team-import endpoint. An empty source collection installs
no examples or placeholder teams.

The first installation disables the whole package and every team workflow, even
when the source manifest marks them enabled. Agents displays its integration
source and lets the operator enable a selected workflow. Enabling one team also
opens the package's master gate while leaving its other team workflows disabled.
The package master switch can disable all its workflows together. Assignment
overlays remain editable for these integrations.

Subsequent source versions are staged beside the active revision. Existing
operator enable choices, local settings revisions, and archived state remain
intact. Unchanged source is a no-op on later starts, including after an operator
has changed a workflow's enabled state. New versions carry forward the enabled
choices for identities that already exist; new team identities begin disabled.
Activation remains an explicit operator action.

Public uploads cannot overwrite an integrated identity, and a source integration
cannot take over an existing user package's identity. Managed instructions are
edited in their source file, rather than through the public package editor.
Export and revision history remain available for backup and recovery.

## Imports and revisions

The agent import preview shows specialists, selected tools, required connectors,
skills, resource paths, and whether that identity already exists. The first
explicit Import creates and activates a package. Importing another version or
revision of the same identity stages it alongside the current active revision.
**Activate** explicitly selects the staged revision. Local edits produce a new
revision and retain the original, including when the semantic version is unchanged.

Source manifests live in immutable version and content-hash revision directories.
The active pointer and enabled state are stored in an atomic index. Save,
activation, enable changes, and archive actions require the expected active
revision so a stale editor cannot silently replace a newer edit. Archive retains
the source and history for export and recovery.

An individual specialist or team can also be deleted from a package. Deleting a
specialist removes its team memberships, removes teams left without members,
and chooses the first remaining member when its coordinator was removed.
Deleting a team retains its specialists as individual entries. Deleting the
last specialist archives the package recoverably. Earlier source revisions,
exports, and conversation history are retained. Active package work must finish
or be stopped before editing, activating, deleting, or archiving that package.

Active agents receive separate revision-specific workspaces containing their
instructions, metadata, skills, and resources. Edit instructions through the
Agents editor; editing a projected workspace file directly can cause the source
integrity checks to fail. Application updates do not migrate these packages into
the built-in agent folders.

## Folder and Markdown imports

A selected agent folder must include exactly one `glados-agent.json`, `manifest.json`,
or file ending in `.glados-agent.json`. Other UTF-8 files beneath that manifest's
directory become resources. Paths in the manifest refer to that directory.
Embedded resources and selected files at the same path must match.
The public JSON, folder, and Markdown import paths cannot install team manifests;
wrapping a manifest or selecting it as a folder does not bypass this restriction.

An instruction Markdown file imports as a new specialist with empty connector
and tool selections. Its initial identity is derived from its title and content;
export it as a package before distributing future versions with a stable ID.

Imports accept at most 32 agents, 16 teams, 250 resources, and 5 MiB of normalized
package content. Each resource is at most 512 KiB; each agent or skill instruction
is at most 128 KiB. Resources must be text with safe relative paths. Symlinks,
absolute paths, parent traversal, hidden paths, duplicate paths, prototype keys,
and filenames reserved for GLaDOS's agent metadata are rejected.
