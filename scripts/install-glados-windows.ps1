[CmdletBinding()]
param([switch]$PrerequisitesOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'GLaDOS supports Windows 11 x64 only.'
}
if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
  throw 'Windows Package Manager (winget) is required. Install App Installer from Microsoft, then run this script again.'
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Add-UserPath([string]$Directory) {
  if (-not $Directory -or -not (Test-Path -LiteralPath $Directory)) { return }
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($current -split ';' | Where-Object { $_ })
  if ($entries -notcontains $Directory) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $Directory) -join ';'), 'User')
  }
  if (($env:Path -split ';') -notcontains $Directory) { $env:Path = "$Directory;$env:Path" }
}

function Install-WingetPackage([string]$Id) {
  Write-Host "Installing $Id..."
  & winget.exe install --exact --id $Id --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $Id (exit $LASTEXITCODE)." }
  Refresh-ProcessPath
}

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Install-WingetPackage 'Git.Git' }
if (-not (Get-Command jq.exe -ErrorAction SilentlyContinue)) { Install-WingetPackage 'jqlang.jq' }
if (-not (Get-Command sqlite3.exe -ErrorAction SilentlyContinue)) { Install-WingetPackage 'SQLite.SQLite' }
if (-not (Get-Command nmap.exe -ErrorAction SilentlyContinue)) { Install-WingetPackage 'Insecure.Nmap' }
if (-not (Get-Command python.exe -ErrorAction SilentlyContinue) -and -not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
  Install-WingetPackage 'Python.Python.3.12'
}
if (-not (Get-Command openssl.exe -ErrorAction SilentlyContinue)) {
  Install-WingetPackage 'ShiningLight.OpenSSL.Light'
  Add-UserPath (Join-Path $env:ProgramFiles 'OpenSSL-Win64\bin')
}

$python = $null
if (Get-Command py.exe -ErrorAction SilentlyContinue) {
  $python = (& py.exe -3.12 -c 'import sys; print(sys.executable)').Trim()
} elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
  $python = (Get-Command python.exe).Source
}
if (-not $python -or -not (Test-Path -LiteralPath $python)) { throw 'Python 3.12 was not found after installation.' }

& $python -m pip install --user --disable-pip-version-check 'pipx==1.7.1'
if ($LASTEXITCODE -ne 0) { throw 'pipx installation failed.' }
$pythonUserBase = (& $python -c 'import site; print(site.getuserbase())').Trim()
Add-UserPath (Join-Path $pythonUserBase 'Scripts')
& $python -m pipx ensurepath | Out-Null
$pipxBin = (& $python -m pipx environment --value PIPX_BIN_DIR).Trim()
Add-UserPath $pipxBin

if (-not (Get-Command mitmdump.exe -ErrorAction SilentlyContinue)) {
  & $python -m pipx install 'mitmproxy==12.2.3'
  if ($LASTEXITCODE -ne 0) { throw 'mitmproxy installation failed.' }
}
if (-not (Get-Command mitmdump.exe -ErrorAction SilentlyContinue)) {
  throw 'mitmdump.exe was not found after installation. Open a new PowerShell session and run this installer again.'
}
if (-not (Get-Command semgrep.exe -ErrorAction SilentlyContinue)) {
  & $python -m pipx install 'semgrep==1.176.0'
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Semgrep is optional and could not be installed on this Windows host.' }
}
$semgrepCommand = Get-Command semgrep.exe -ErrorAction SilentlyContinue
$pysemgrepCommand = Get-Command pysemgrep.exe -ErrorAction SilentlyContinue
$semgrepUsable = $false
if ($semgrepCommand) {
  & $semgrepCommand.Source --version
  $semgrepUsable = ($LASTEXITCODE -eq 0)
  if (-not $semgrepUsable -and $pysemgrepCommand) {
    & $pysemgrepCommand.Source --version
    $semgrepUsable = ($LASTEXITCODE -eq 0)
  }
} elseif ($pysemgrepCommand) {
  & $pysemgrepCommand.Source --version
  $semgrepUsable = ($LASTEXITCODE -eq 0)
}
if (-not $semgrepUsable) { Write-Warning 'Semgrep is optional, but neither installed CLI entry point is usable.' }

Write-Host 'GLaDOS Windows runtime prerequisites are installed.'
Write-Host 'Open a new PowerShell session before running the native compatibility build.'
if ($PrerequisitesOnly) { return }

Write-Host ''
Write-Host 'Windows binaries are not distributed by GLaDOS. Build a tagged release from source:'
Write-Host '  https://github.com/samcsta/GLaDOS'
Write-Host ''
Write-Host 'From the cloned release directory, run:'
Write-Host '  npm ci --prefix desktop'
Write-Host '  npm ci --prefix watchdog'
Write-Host '  npm ci --prefix dashboard'
Write-Host '  npm ci --prefix blackboard/blackboard-mcp'
Write-Host '  npm ci --prefix watchdog/watchdog-mcp'
Write-Host '  npm ci --prefix tools/glados-ops-mcp'
Write-Host '  npm test --prefix desktop'
Write-Host '  npm test --prefix dashboard'
Write-Host '  npm run pack:windows --prefix desktop'
Write-Host '  npm run smoke:windows --prefix desktop'
Write-Host ''
Write-Host 'Then launch artifacts\desktop\win-unpacked\GLaDOS.exe.'
Write-Warning 'The locally built application is unsigned. Only run a build made from source you verified.'
