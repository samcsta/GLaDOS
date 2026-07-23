# Install GLaDOS v4 on macOS from Gitea

Use this procedure for a new internal installation from the GLaDOS Gitea
repository. It builds `GLaDOS.app` locally on the operator's Mac and installs
it in `/Applications`.

Do not copy another operator's checkout, `.env`, or `~/.glados` directory.
Those locations can contain machine-specific configuration, credentials,
reports, investigations, and assessment evidence.

## Requirements

- An Apple Silicon Mac. `uname -m` must print `arm64`.
- A Gitea account with read access to `scosta44/glados`.
- Administrator access for Apple Command Line Tools, Homebrew packages, the
  application install, and local CA trust.
- A LiteLLM key issued for this operator.
- Network access to `git.r3dt34m.net` and the configured LiteLLM endpoint.

The current production target is Apple Silicon. Stop and contact the release
owner if `uname -m` prints `x86_64`; do not try to install the arm64 build on an
Intel Mac.

## 1. Configure Gitea SSH access

Check whether the Mac already has an SSH public key:

```bash
find "$HOME/.ssh" -maxdepth 1 -name '*.pub' -print 2>/dev/null
```

If no public key is listed, create one. Use the operator's work email address
as the comment:

```bash
ssh-keygen -t ed25519 -C 'operator@company.com'
```

Accept the default path unless the operator already uses a deliberate SSH key
layout. Protect the key with a passphrase. Copy the public key:

```bash
pbcopy < "$HOME/.ssh/id_ed25519.pub"
```

Sign in to `https://git.r3dt34m.net`, open **Settings**, select
**SSH / GPG Keys**, choose **Add Key**, and paste the public key. Never upload
or share the private key (the file without `.pub`).

Test both SSH authentication and repository access:

```bash
git ls-remote git@git.r3dt34m.net:scosta44/glados.git HEAD
```

On the first connection, compare the displayed SSH host fingerprint with the
fingerprint published by the repository administrator before accepting it. A
successful test prints a commit hash followed by `HEAD`. If it reports
`Permission denied (publickey)` or `repository does not exist`, fix the Gitea
account/key permissions before continuing.

## 2. Install Mac prerequisites

Confirm the architecture:

```bash
uname -m
```

Install Apple Command Line Tools if they are not already installed:

```bash
xcode-select -p >/dev/null 2>&1 || xcode-select --install
```

If the installer opens, let it finish before continuing. Install Homebrew
through the organization's approved process if `brew --version` is not
available. On an Apple Silicon Mac, a newly installed Homebrew may need to be
added to the current shell:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Install the supported Node.js release and Git:

```bash
brew install node@22 git
brew link --overwrite --force node@22
node --version
git --version
```

The Node.js version must be 20 or 22; Node 22 is recommended.

## 3. Clone GLaDOS from Gitea

Choose a normal source-code directory owned by the operator. This example uses
the operator's home directory:

```bash
cd "$HOME"
git clone git@git.r3dt34m.net:scosta44/glados.git GLaDOS
cd GLaDOS
git switch main
git status --short --branch
cat VERSION
```

The checkout should be on `main`, have no local changes, and print the expected
GLaDOS v4 release from `VERSION`.

## 4. Bootstrap this Mac

Run the repository bootstrap:

```bash
scripts/bootstrap-macos.sh
```

Bootstrap installs application and MCP dependencies, installs the required
core CLI tools, creates the runtime databases, seeds missing agent workspaces,
generates a unique local interception CA, and creates the local operator
context. It does not overwrite existing editable agent workspaces.

Store this operator's LiteLLM key in macOS Keychain:

```bash
scripts/setup-llm-secret.sh
```

Enter the key when prompted. Do not put it in `.env`, paste it into chat, or
reuse another operator's local Keychain entry.

Bootstrap seeds the Ford red-team operator context. Review the local copy
before starting an assessment:

```bash
open -a TextEdit "$HOME/.glados/operator-context.json"
```

The operator context provides background operating knowledge; it does not
authorize active testing. The engagement's approved scope and rules of
engagement remain controlling.

If this operator needs the supported ADFS or Dradis credential helpers, create
their local credential file interactively:

```bash
scripts/setup-local-secrets.sh
```

This step is optional and must use the operator's own authorized credentials.

## 5. Trust the local CA and verify the installation

Trust the unique CA generated for this Mac:

```bash
scripts/glados-ca.sh trust
```

macOS may request administrator approval. This CA enables GLaDOS's supervised
local `mitmproxy` capture. Do not export or copy a CA from another workstation.

Run the complete dependency and configuration check:

```bash
scripts/glados-doctor.sh
```

Resolve every required failure before continuing. Optional specialist-tool
warnings may be handled later, or the wider tool set can be installed with:

```bash
scripts/setup-redteam-tools.sh --all --install
```

NetExec is installed from its official Git repository rather than PyPI. The
tool installer also installs its required Rust toolchain through Homebrew.

## 6. Build and install the desktop app

Build a local package, verify it, and install it in `/Applications`:

```bash
scripts/install-desktop-app.sh
open /Applications/GLaDOS.app
```

If the desktop packaging dependencies were not installed during an earlier or
partial bootstrap, the installer repairs them before invoking
`electron-builder`.

The app bundle is `/Applications/GLaDOS.app`; operator data remains under
`~/.glados`. On first launch, open Settings and confirm that the expected
LiteLLM models are available before running an assessment.

## Updating this installation

Finish or stop active agent runs first. From the source checkout, preview and
apply the Gitea update, then rebuild the installed app:

```bash
cd "$HOME/GLaDOS"
scripts/update.sh --dry-run
scripts/update.sh
scripts/install-desktop-app.sh
open /Applications/GLaDOS.app
```

The update command requires a clean `main` checkout and fast-forwards from the
Gitea `origin`. Runtime state under `~/.glados` is preserved.

## Do not use an unsigned shared DMG

Do not transfer a development DMG from `artifacts/desktop`. A normal shared
Mac installer must be produced by the release owner with a Developer ID
Application certificate, Apple notarization, and the repository's release
verification command. Until that release process is available, each authorized
operator should use the source installation above.
