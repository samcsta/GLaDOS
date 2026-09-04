[CmdletBinding()]
param(
  [string]$UpdateBase = $(if ($env:GLADOS_UPDATE_BASE_URL) { $env:GLADOS_UPDATE_BASE_URL } else { 'https://updates.r3dt34m.net/glados/windows/x64' }),
  [switch]$PrerequisitesOnly
)

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

if ($PrerequisitesOnly) {
  Write-Host 'GLaDOS Windows runtime prerequisites are installed.'
  Write-Host 'Open a new PowerShell session before running the native compatibility build.'
  return
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("glados-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $metadataPath = Join-Path $temporary 'latest.yml'
  Write-Host 'Reading the private GLaDOS release channel...'
  Invoke-WebRequest -UseBasicParsing -Uri "$UpdateBase/latest.yml" -OutFile $metadataPath
  $metadata = Get-Content -Raw -LiteralPath $metadataPath
  $versionMatch = [regex]::Match($metadata, '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$')
  $artifactMatch = [regex]::Match($metadata, '(?m)^\s*-\s*url:\s*(GLaDOS-[0-9]+\.[0-9]+\.[0-9]+-x64\.exe)\s*$')
  $shaMatch = [regex]::Match($metadata, '(?m)^\s*sha512:\s*(\S+)\s*$')
  if (-not $versionMatch.Success -or -not $artifactMatch.Success -or -not $shaMatch.Success) {
    throw 'The GLaDOS Windows release metadata is invalid.'
  }

  $artifact = $artifactMatch.Groups[1].Value
  $installer = Join-Path $temporary $artifact
  Write-Host "Downloading GLaDOS $($versionMatch.Groups[1].Value)..."
  Invoke-WebRequest -UseBasicParsing -Uri "$UpdateBase/$artifact" -OutFile $installer
  $sha512 = [Security.Cryptography.SHA512]::Create()
  try { $actualHash = [Convert]::ToBase64String($sha512.ComputeHash([IO.File]::ReadAllBytes($installer))) }
  finally { $sha512.Dispose() }
  if ($actualHash -cne $shaMatch.Groups[1].Value) { throw 'The downloaded installer did not match the release metadata hash.' }

  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($signature.Status -ne 'Valid') {
    throw "The GLaDOS installer has an invalid Authenticode signature: $($signature.Status) $($signature.StatusMessage)"
  }
  Write-Host 'Launching the signed GLaDOS installer...'
  $process = Start-Process -FilePath $installer -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "The GLaDOS installer exited with $($process.ExitCode)." }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'GLaDOS and its Windows runtime prerequisites are installed.'
Write-Host 'Future releases will appear as an Update GLaDOS button inside the app.'
