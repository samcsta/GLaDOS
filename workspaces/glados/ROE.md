# Rules of Engagement Template

This is a generic local template. Replace it per engagement in the local runtime or operator notes. Do not commit real customer scopes, credentials, approval tokens, VPN details, or private contacts to the repo.

## Engagement

| Field | Value |
| --- | --- |
| Engagement ID | `<target>-YYYYMMDD` |
| Target Name | `<customer/app/system>` |
| Authorized By | `<approver / ticket / written authorization>` |
| Operator | `<local operator>` |
| Test Window | `<dates/times/timezone>` |
| Emergency Contact | `<local-only contact reference>` |

## In Scope

- `<exact host, domain, CIDR, app, path, or account>`

## Out of Scope

- `<excluded systems, actions, data classes, time windows>`

## Authorized Activities

- Passive reconnaissance
- Active reconnaissance at ROE-approved rates
- Web application assessment
- API assessment
- Source/client-side artifact review
- Evidence collection with redaction
- Validation of suspected vulnerabilities

## Restricted Activities

These require explicit operator confirmation or written ROE approval:

- Exploitation beyond proof of vulnerability
- Persistence
- Lateral movement
- Social engineering
- Phishing
- Credential spraying/password guessing
- Denial-of-service or stress testing
- Accessing, exporting, or storing real sensitive data

## Credentials

Credentials, SSO flows, API keys, test users, VPN requirements, and customer portals are supplied locally by the operator. They must not be hardcoded in agent seeds or committed to Git.

## Evidence Handling

- Reports: `~/.glados/reports/<engagement>/`
- Evidence: `~/.glados/investigations/<target>/evidence/`
- Blackboard: `~/.glados/blackboard/blackboard.db`
- Watchdog: `~/.glados/watchdog/watchdog.db`

Sharing evidence or reports requires explicit export.

## Confirmation

The operator confirms that the current assessment is authorized and that the scope in this ROE is accurate before GLaDOS launches active testing.
