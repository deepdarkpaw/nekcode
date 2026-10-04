# nekcode installer and updater for Windows (PowerShell 5.1+). Running it again updates an existing install.
#
#   irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
#
# Options (environment variables, set before running):
#   NEK_INSTALL_DIR  source checkout        (default: %LOCALAPPDATA%\nekcode)
#   NEK_BIN_DIR      where nek.cmd is put   (default: %LOCALAPPDATA%\nekcode\bin, added to the user PATH)
#   NEK_REPO_URL     git repository         (default: https://github.com/deepdarkpaw/nekcode.git)
#   NEK_BRANCH       branch to track        (default: nek)
#   NEK_SKIP_TOOLS=1 skip fd / rg / ast-grep setup

$ErrorActionPreference = 'Stop'

function Get-Option([string]$Name, [string]$Default) {
	$value = [Environment]::GetEnvironmentVariable($Name)
	if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
	return $value
}

$RepoUrl = Get-Option 'NEK_REPO_URL' 'https://github.com/deepdarkpaw/nekcode.git'
$Branch = Get-Option 'NEK_BRANCH' 'nek'
$InstallDir = Get-Option 'NEK_INSTALL_DIR' (Join-Path $env:LOCALAPPDATA 'nekcode')
$BinDir = Get-Option 'NEK_BIN_DIR' (Join-Path $InstallDir 'bin')
$MinNode = [version]'22.19.0'
$Resolver = 'packages/coding-agent/src/experimental/source-resolver.ts'

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

function Stop-Install([string]$Message) { throw "nek install failed: $Message" }

# Run a native command and stop on a non-zero exit code (PowerShell does not do this by itself).
function Invoke-Native([string]$Command, [string[]]$Arguments) {
	& $Command @Arguments
	if ($LASTEXITCODE -ne 0) { Stop-Install "$Command $($Arguments -join ' ') exited with code $LASTEXITCODE" }
}

function Assert-Command([string]$Name, [string]$Hint) {
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Stop-Install "$Name is required. $Hint" }
}

function Test-Prerequisites {
	Write-Step 'Checking prerequisites'
	Assert-Command 'git' 'Install it with: winget install Git.Git'
	Assert-Command 'node' "Install Node.js $MinNode or newer with: winget install OpenJS.NodeJS.LTS"
	Assert-Command 'npm.cmd' 'npm ships with Node.js.'
	$nodeVersion = [version](& node -p 'process.versions.node')
	if ($nodeVersion -lt $MinNode) { Stop-Install "Node.js $MinNode or newer is required (found $nodeVersion)." }
	Write-Host "git $((& git --version) -replace 'git version ', ''), node $nodeVersion, npm $(& npm.cmd --version)"
}

# Clone on first install; fast-forward on update. Never touches local edits.
function Sync-Source {
	if (Test-Path (Join-Path $InstallDir '.git')) {
		Write-Step "Updating $InstallDir"
		$changes = & git -C $InstallDir status --porcelain --untracked-files=no
		if ($changes) { Stop-Install "$InstallDir has local changes. Commit or discard them, then run the installer again." }
		Invoke-Native 'git' @('-C', $InstallDir, 'fetch', '--depth', '1', 'origin', $Branch)
		Invoke-Native 'git' @('-C', $InstallDir, 'checkout', '-q', '-B', $Branch, 'FETCH_HEAD')
	} elseif ((Test-Path $InstallDir) -and (Get-ChildItem -Force $InstallDir | Select-Object -First 1)) {
		Stop-Install "$InstallDir exists and is not a git checkout. Remove it or set NEK_INSTALL_DIR."
	} else {
		Write-Step "Cloning $RepoUrl ($Branch) into $InstallDir"
		Invoke-Native 'git' @('clone', '--depth', '1', '--branch', $Branch, $RepoUrl, $InstallDir)
	}
	Write-Host "at $(& git -C $InstallDir log -1 --format='%h %s')"
}

# npm ci only when the lockfile changed since the last successful install.
function Install-Dependencies {
	$stamp = Join-Path $InstallDir 'node_modules\.nek-lock'
	$lock = (& git -C $InstallDir rev-parse 'HEAD:package-lock.json').Trim()
	if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lock)) {
		Write-Step 'Dependencies are up to date'
		return
	}
	Write-Step 'Installing dependencies (npm ci)'
	Push-Location $InstallDir
	try { Invoke-Native 'npm.cmd' @('ci', '--ignore-scripts', '--no-audit', '--no-fund') } finally { Pop-Location }
	Set-Content -Path $stamp -Value $lock -Encoding ascii
}

# The built-in model catalog is generated, not committed. Refresh it on every install or update.
function Update-ModelData {
	Write-Step 'Generating the built-in model catalog'
	Push-Location $InstallDir
	try { Invoke-Native 'npm.cmd' @('run', '--silent', 'hydrate:model-data') } finally { Pop-Location }
	if (-not (Test-Path (Join-Path $InstallDir 'packages\ai\src\providers\data'))) {
		Stop-Install 'model catalog was not generated'
	}
}

# nek.cmd serves cmd and PowerShell; the extensionless script serves Git Bash.
function Write-Launchers {
	Write-Step "Installing the nek command into $BinDir"
	New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
	$root = $InstallDir -replace '\\', '/'
	$cmd = @"
@echo off
rem nek launcher written by scripts/install.ps1: runs nekcode from source in $InstallDir.
node --import "file:///$root/$Resolver" "$InstallDir\packages\coding-agent\src\cli.ts" %*
exit /b %ERRORLEVEL%
"@
	$bash = "#!/usr/bin/env bash`n# nek launcher written by scripts/install.ps1: runs nekcode from source in $root.`n" +
		"exec node --import `"file:///$root/$Resolver`" `"$root/packages/coding-agent/src/cli.ts`" `"`$@`"`n"
	# cmd.exe reads batch files in the OEM code page, which matters for non-ASCII user names.
	$oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
	[IO.File]::WriteAllText((Join-Path $BinDir 'nek.cmd'), ($cmd -replace "`r?`n", "`r`n") + "`r`n", $oem)
	[IO.File]::WriteAllText((Join-Path $BinDir 'nek'), $bash, (New-Object Text.UTF8Encoding $false))
}

# Prepend BinDir to the user PATH in the registry, keeping %VAR% references unexpanded.
function Add-ToUserPath {
	$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
	try {
		$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
		$entries = @($raw -split ';' | Where-Object { $_ })
		if ($entries -contains $BinDir) { return $false }
		$key.SetValue('Path', ((@($BinDir) + $entries) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
	} finally { $key.Close() }
	# Setting a user variable broadcasts WM_SETTINGCHANGE, so new terminals see the new PATH.
	[Environment]::SetEnvironmentVariable('NEK_PATH_REFRESH', '1', 'User')
	[Environment]::SetEnvironmentVariable('NEK_PATH_REFRESH', $null, 'User')
	$env:Path = "$BinDir;$env:Path"
	return $true
}

function Install-Tools {
	if ($env:NEK_SKIP_TOOLS -eq '1') {
		Write-Step 'Skipping fd / rg / ast-grep setup (NEK_SKIP_TOOLS=1)'
		return
	}
	Write-Step 'Setting up fd, rg, ast-grep'
	Push-Location $InstallDir
	try { & node --import "./$Resolver" 'scripts/setup-tools.ts' } finally { Pop-Location }
	if ($LASTEXITCODE -ne 0) {
		Write-Warning 'Some search tools are unavailable (see above). nek still runs; the listed features fail until they are installed.'
	}
}

Test-Prerequisites
Sync-Source
Install-Dependencies
Update-ModelData
Write-Launchers
$pathAdded = Add-ToUserPath
Install-Tools
Write-Step "Done: $(& (Join-Path $BinDir 'nek.cmd') --version)"
if ($pathAdded) { Write-Host "Added $BinDir to your user PATH. Open a new terminal, then run 'nek' in any project directory." }
else { Write-Host "Run 'nek' in any project directory." }
Write-Host 'Update later by running this installer again.'
