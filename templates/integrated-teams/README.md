# Integrated team source collection

Add trusted team integrations here as `<stable-name>.glados-agent.json` files
using the portable format documented in [Agent packages](../../docs/AGENT-PACKAGES.md).
Keep the package ID and individual agent/team IDs stable across versions; increase
the semantic version when updating instructions, capabilities, or resources.

The dashboard seeds these files into the user's durable package collection on
startup. First installations disable the package and each team workflow. The
operator enables workflows in Agents. Later source versions are staged for
explicit activation and preserve operator enable choices and prior revisions.

Public agent uploads cannot install teams or overwrite an integrated identity.
Source integrations cannot take over a preexisting user package ID. Missing or
empty collections install nothing. This directory intentionally ships no sample
team packages.

To integrate a team with Codex, add its instructions, metadata, connectors, tool
selections, member relationships, and text resources to a package here, then run
the package and dashboard checks before rebuilding the desktop application.
