# Local Secrets And Operator Context

GLaDOS separates non-secret operating knowledge from credentials.

## Operator Context

Committed template:

```text
templates/operator-context/ford-redteam.json
```

Local editable copy:

```text
~/.glados/operator-context.json
```

Operator context can include non-secret background knowledge such as owned domain
families, known SSO hosts, Dradis hosts, auth-flow cues, and reporting paths.
It does not make a host active-testing scope by itself. It only tells GLaDOS how
to interpret dependencies and when to ask for approval.

Install or refresh the local copy:

```bash
scripts/setup-operator-context.sh
```

## Local Secrets

Local credentials live outside Git:

```text
~/.glados/secrets/local-auth.json
```

Create it interactively:

```bash
scripts/setup-local-secrets.sh
```

The script prompts without echoing passwords, writes the file with `0600`
permissions, and never commits the values. Each red teamer runs this locally
with their own credentials.

The schema mirrors:

```text
templates/local-secrets.example.json
```

## Assessment Use

GLaDOS should treat auth/runtime dependencies separately from target scope.
For example, a FordTube assessment may actively target the FordTube host while
allowing Ford ADFS hosts only for login and rendering. Dependency hosts are not
fuzzing or exploitation targets unless the operator explicitly expands scope and
approves a plan.
