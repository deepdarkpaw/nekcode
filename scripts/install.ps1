# Source installer for Windows (PowerShell 5.1+).
# Options: NEK_INSTALL_DIR, NEK_BIN_DIR, NEK_REPO_URL, NEK_BRANCH,
# NEK_CHANNEL (stable|dev), NEK_SKIP_TOOLS=1, NEK_INSTALL_BUN=1,
# NEK_NODE_DIR, NEK_NODE_MIRROR, NEK_NODE_VERSION.
$ErrorActionPreference = 'Stop'

function Get-Option([string]$Name, [string]$Default) {
	$value = [Environment]::GetEnvironmentVariable($Name)
	if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
	return $value
}
function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Stop-Install([string]$Message) { throw "nek install failed: $Message" }
function Invoke-Native([string]$Command, [string[]]$Arguments) {
	& $Command @Arguments
	if ($LASTEXITCODE -ne 0) { Stop-Install "$Command $($Arguments -join ' ') exited with code $LASTEXITCODE" }
}
function Get-Git([string[]]$Arguments) {
	$output = & git @Arguments
	if ($LASTEXITCODE -ne 0) { Stop-Install "git $($Arguments -join ' ') exited with code $LASTEXITCODE" }
	return (($output | Out-String).Trim())
}

$RepoUrl = Get-Option 'NEK_REPO_URL' 'https://github.com/deepdarkpaw/nekcode.git'
$InstallDir = [IO.Path]::GetFullPath((Get-Option 'NEK_INSTALL_DIR' (Join-Path $env:LOCALAPPDATA 'nekcode')))
$StateFile = Join-Path $InstallDir '.nek-install-state.json'
$state = $null
if (Test-Path $StateFile) { $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
$savedBin = Join-Path $InstallDir 'bin'
$savedChannel = 'stable'
$savedBranch = 'nek'
$savedSkip = '0'
$savedBun = '0'
$defaultNodeDir = Join-Path $env:USERPROFILE '.nek\node'
$savedNodeDir = $defaultNodeDir
if ($state.skipTools) { $savedSkip = '1' }
if ($state.installBun) { $savedBun = '1' }
if ($state.binDir) { $savedBin = $state.binDir }
if ($state.channel) { $savedChannel = $state.channel }
if ($state.branch) { $savedBranch = $state.branch }
if ($state.nodeDir) { $savedNodeDir = $state.nodeDir }
$BinDir = [IO.Path]::GetFullPath((Get-Option 'NEK_BIN_DIR' $savedBin))
$SkipTools = Get-Option 'NEK_SKIP_TOOLS' $savedSkip
$InstallBun = Get-Option 'NEK_INSTALL_BUN' $savedBun
$Channel = Get-Option 'NEK_CHANNEL' $savedChannel
$Branch = Get-Option 'NEK_BRANCH' $savedBranch
$NodeInstallDir = [IO.Path]::GetFullPath((Get-Option 'NEK_NODE_DIR' $savedNodeDir))
$AutoNodeVersion = Get-Option 'NEK_NODE_VERSION' '22.19.0'
$NodeDistUrl = Get-Option 'NEK_NODE_MIRROR' 'https://nodejs.org/dist'
if ($Channel -ne 'stable' -and $Channel -ne 'dev') { Stop-Install 'NEK_CHANNEL must be stable or dev.' }
$MinNode = [version]'22.19.0'
$Resolver = 'packages/coding-agent/src/experimental/source-resolver.ts'

function Test-NodeValid([string]$Command) {
	if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return $false }
	try {
		$raw = & $Command -p 'process.versions.node' 2>$null
		if (-not $raw) { return $false }
		$ver = [version]$raw.Trim()
		return ($ver -ge $MinNode)
	} catch {
		return $false
	}
}

function Install-Node {
	Write-Step "Installing Node.js $AutoNodeVersion into $NodeInstallDir"
	$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
	$pkgName = "node-v$AutoNodeVersion-win-$arch.zip"
	$url = "$($NodeDistUrl.TrimEnd('/'))/v$AutoNodeVersion/$pkgName"
	$tempZip = Join-Path ([IO.Path]::GetTempPath()) "nek-$pkgName"
	$tempExtract = Join-Path ([IO.Path]::GetTempPath()) "nek-node-extract-$([Guid]::NewGuid().ToString('N'))"

	Write-Host "Downloading $url"
	try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]'Tls12,Tls13' } catch {}
	$webClient = New-Object System.Net.WebClient
	try {
		$webClient.DownloadFile($url, $tempZip)
	} catch {
		Stop-Install "Failed to download Node.js from ${url}: $($_.Exception.Message)"
	} finally {
		$webClient.Dispose()
	}

	Write-Step 'Extracting Node.js'
	if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
	New-Item -ItemType Directory -Force -Path $tempExtract | Out-Null
	[System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') | Out-Null
	[System.IO.Compression.ZipFile]::ExtractToDirectory($tempZip, $tempExtract)

	New-Item -ItemType Directory -Force -Path $NodeInstallDir | Out-Null
	$extractedFolder = Join-Path $tempExtract "node-v$AutoNodeVersion-win-$arch"
	if (Test-Path $extractedFolder) {
		Get-ChildItem -Path $extractedFolder | ForEach-Object {
			$dest = Join-Path $NodeInstallDir $_.Name
			if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
			Move-Item -Path $_.FullName -Destination $NodeInstallDir -Force
		}
	}

	Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
	Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue
}

function Ensure-Node {
	if ((Test-NodeValid 'node') -and (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue)) {
		return
	}

	$installedNode = Join-Path $NodeInstallDir 'node.exe'
	$installedNpm = Join-Path $NodeInstallDir 'npm.cmd'
	if ((Test-Path $installedNode) -and (Test-Path $installedNpm) -and (Test-NodeValid $installedNode)) {
		$env:Path = "$NodeInstallDir;$env:Path"
		return
	}

	Install-Node
	$env:Path = "$NodeInstallDir;$env:Path"

	if (-not (Test-NodeValid 'node') -or -not (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue)) {
		Stop-Install "Node.js $MinNode or newer is required, and automated installation failed. Install it manually: https://nodejs.org/"
	}
}

function Test-Prerequisites {
	Write-Step 'Checking prerequisites'
	if (-not (Get-Command 'git' -ErrorAction SilentlyContinue)) { Stop-Install 'git is required. Install git with your package manager.' }
	Ensure-Node
}

function Sync-Source {
	$remote = $RepoUrl
	$fresh = $false
	$target = $Branch
	if (Test-Path (Join-Path $InstallDir '.git')) {
		Write-Step "Updating $InstallDir ($Channel)"
		$changes = Get-Git @('-C', $InstallDir, 'status', '--porcelain', '--untracked-files=no')
		if ($changes) { Stop-Install "$InstallDir has local changes. Commit or discard them before updating." }
		$remote = Get-Git @('-C', $InstallDir, 'remote', 'get-url', 'origin')
	} elseif ((Test-Path $InstallDir) -and (Get-ChildItem -Force $InstallDir | Select-Object -First 1)) {
		Stop-Install "$InstallDir exists and is not a git checkout. Set NEK_INSTALL_DIR to another path."
	} else { $fresh = $true }
	if ($Channel -eq 'stable') {
		$refs = Get-Git @('ls-remote', '--tags', '--refs', $remote, 'refs/tags/nek-v*')
		$selector = @'
let text='';
process.stdin.on('data', c => text += c);
process.stdin.on('end', () => {
 const versions = text.split(/\r?\n/).map(line => line.trim().split(/\s+/).at(-1)?.replace('refs/tags/', ''))
  .map(tag => ({ tag, match: /^nek-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag || '') }))
  .filter(v => v.match && v.match.slice(1,4).every(n => Number.isSafeInteger(Number(n))) && (!v.match[4] || v.match[4].split('.').every(p => p && (!/^\d+$/.test(p) || !/^0\d/.test(p)))))
  .map(v => ({ tag: v.tag, core: v.match.slice(1,4).map(Number), pre: v.match[4]?.split('.') || [] }));
 const compare = (a,b) => {
  for (let i=0;i<3;i++) if (a.core[i]!==b.core[i]) return a.core[i]-b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length ? (!b.pre.length ? 0 : 1) : -1;
  for (let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
   const x=a.pre[i],y=b.pre[i]; if(x===y)continue; if(x===undefined)return -1;if(y===undefined)return 1;
   const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return BigInt(x)<BigInt(y)?-1:1;if(xn!==yn)return xn?-1:1;return x<y?-1:1;
  } return 0;
 };
 versions.sort((a,b)=>compare(b,a)); process.stdout.write(versions[0]?.tag || '');
});
'@
		$target = $refs | & node -e $selector
		if ($LASTEXITCODE -ne 0) { Stop-Install 'Stable tag selection failed.' }
		if (-not $target) { Stop-Install "No nek-v* stable release tags found. Use NEK_CHANNEL=dev to track $Branch." }
	}
	if ($fresh) {
		Write-Step "Cloning $remote ($target) into $InstallDir"
		# A release tag is annotated; 'clone --branch <tag>' warns that the tag object "is not a commit".
		# The full clone already has the tag, so stable checks it out below instead.
		if ($Channel -eq 'stable') {
			Invoke-Native 'git' @('clone', '--no-checkout', $remote, $InstallDir)
		} else {
			Invoke-Native 'git' @('clone', '--no-checkout', '--branch', $target, $remote, $InstallDir)
		}
		$targetRef = $target
	} else {
		if ((Get-Git @('-C', $InstallDir, 'rev-parse', '--is-shallow-repository')) -eq 'true') {
			Invoke-Native 'git' @('-C', $InstallDir, 'fetch', '--unshallow', 'origin')
		}
		Invoke-Native 'git' @('-C', $InstallDir, 'fetch', 'origin', $target)
		$currentBranch = & git -C $InstallDir symbolic-ref --quiet --short HEAD
		$releaseHead = ''
		if (-not $currentBranch) { $releaseHead = (Get-Git @('-C', $InstallDir, 'tag', '--points-at', 'HEAD', '--list', 'nek-v*')) -split "`n" | Where-Object { $_ -match '^nek-v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' } }
		& git -C $InstallDir merge-base --is-ancestor HEAD FETCH_HEAD
		if (-not $releaseHead -and $LASTEXITCODE -ne 0) {
			Stop-Install "Update refused: HEAD has local commits or diverges from $target. No local branch was moved."
		}
		$targetRef = 'FETCH_HEAD'
	}
	if ($Channel -eq 'stable') {
		Invoke-Native 'git' @('-C', $InstallDir, 'checkout', '-q', '--detach', $targetRef)
	} else {
		& git -C $InstallDir show-ref --verify --quiet "refs/heads/$Branch"
		if ($LASTEXITCODE -eq 0) {
			& git -C $InstallDir merge-base --is-ancestor $Branch $targetRef
			if ($LASTEXITCODE -ne 0) { Stop-Install "Update refused: local branch $Branch has local commits." }
			Invoke-Native 'git' @('-C', $InstallDir, 'checkout', '-q', $Branch)
			Invoke-Native 'git' @('-C', $InstallDir, 'merge', '--ff-only', $targetRef)
		} else { Invoke-Native 'git' @('-C', $InstallDir, 'checkout', '-q', '-b', $Branch, $targetRef) }
	}
	if ($Channel -eq 'dev') { Invoke-Native 'git' @('-C', $InstallDir, 'branch', "--set-upstream-to=origin/$Branch", $Branch) }
	Write-Host "at $(Get-Git @('-C', $InstallDir, 'log', '-1', '--format=%h %s'))"
}

function Install-Dependencies {
	$stamp = Join-Path $InstallDir 'node_modules\.nek-lock'
	$lock = Get-Git @('-C', $InstallDir, 'rev-parse', 'HEAD:package-lock.json')
	if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lock)) {
		Write-Step 'Dependencies are up to date'; return
	}
	Write-Step 'Installing dependencies (npm ci)'
	Push-Location $InstallDir
	try { Invoke-Native 'npm.cmd' @('ci', '--ignore-scripts', '--no-audit', '--no-fund') } finally { Pop-Location }
	Set-Content -Path $stamp -Value $lock -Encoding ascii
}
function Update-ModelData {
	Write-Step 'Generating the built-in model catalog'
	Push-Location $InstallDir
	$ErrorActionPreference = 'Continue'
	try { $output = & npm.cmd run --silent hydrate:model-data 2>&1; $code = $LASTEXITCODE } finally {
		$ErrorActionPreference = 'Stop'; Pop-Location
	}
	if ($code -ne 0) {
		$output | ForEach-Object { Write-Host $_ }
		Stop-Install 'model catalog generation failed; check the network and run again'
	}
	if (-not (Test-Path (Join-Path $InstallDir 'packages\ai\src\providers\data'))) { Stop-Install 'model catalog was not generated' }
}
function Write-Launchers {
	Write-Step "Installing the nek command into $BinDir"
	New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
	$root = (Resolve-Path $InstallDir).Path -replace '\\', '/'
	$resolverUrl = ([uri](Join-Path $InstallDir $Resolver)).AbsoluteUri
	$nodeExePath = Join-Path $NodeInstallDir 'node.exe'
	$cmd = "@echo off`r`n" +
		"setlocal`r`n" +
		"set `"NODE_EXE=node`"`r`n" +
		"where node >nul 2>nul`r`n" +
		"if %ERRORLEVEL% neq 0 (`r`n" +
		"    if exist `"$nodeExePath`" set `"NODE_EXE=$nodeExePath`"`r`n" +
		")`r`n" +
		"`"%NODE_EXE%`" --import `"$resolverUrl`" `"$InstallDir\packages\coding-agent\src\cli.ts`" %*`r`n" +
		"exit /b %ERRORLEVEL%`r`n"
	$bash = "#!/usr/bin/env bash`n" +
		"NODE_CMD=`"node`"`n" +
		"if ! command -v `"`$NODE_CMD`" >/dev/null 2>&1; then`n" +
		"    if [ -f '$nodeExePath' ]; then NODE_CMD='$nodeExePath'; fi`n" +
		"fi`n" +
		"exec `"`$NODE_CMD`" --import '$resolverUrl' '$root/packages/coding-agent/src/cli.ts' `"`$@`"`n"
	$oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
	[IO.File]::WriteAllText((Join-Path $BinDir 'nek.cmd'), $cmd, $oem)
	[IO.File]::WriteAllText((Join-Path $BinDir 'nek'), $bash, (New-Object Text.UTF8Encoding $false))
	$json = @{ binDir = $BinDir; channel = $Channel; branch = $Branch; skipTools = ($SkipTools -eq '1'); installBun = ($InstallBun -eq '1'); nodeDir = $NodeInstallDir } | ConvertTo-Json
	[IO.File]::WriteAllText($StateFile, $json + "`n", (New-Object Text.UTF8Encoding $false))
}
function Add-ToUserPath {
	$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
	try {
		$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
		$entries = @($raw -split ';' | Where-Object { $_ })
		$pathsToAdd = @()
		if ($entries -notcontains $BinDir) { $pathsToAdd += $BinDir }
		if ((Test-Path (Join-Path $NodeInstallDir 'node.exe')) -and ($entries -notcontains $NodeInstallDir)) {
			$pathsToAdd += $NodeInstallDir
		}
		if ($pathsToAdd.Count -gt 0) {
			$key.SetValue('Path', ((@($pathsToAdd) + $entries) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
		}
	} finally { $key.Close() }
	[Environment]::SetEnvironmentVariable('NEK_PATH_REFRESH', '1', 'User')
	[Environment]::SetEnvironmentVariable('NEK_PATH_REFRESH', $null, 'User')
	$env:Path = "$BinDir;$env:Path"
	if (Test-Path (Join-Path $NodeInstallDir 'node.exe')) {
		$env:Path = "$NodeInstallDir;$env:Path"
	}
}
function Install-Tools {
	if ($SkipTools -eq '1') { return }
	Write-Step 'Setting up fd, rg, ast-grep'
	Push-Location $InstallDir
	try { Invoke-Native 'node' @('--import', "./$Resolver", 'scripts/setup-tools.ts') } finally { Pop-Location }
}
function Install-Bun {
	if ($InstallBun -ne '1' -or (Get-Command bun -ErrorAction SilentlyContinue)) { return }
	Write-Step 'Installing Bun for the optional OpenTUI frontend'
	Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
}

Test-Prerequisites
Sync-Source
Install-Dependencies
Update-ModelData
Write-Launchers
Add-ToUserPath
Install-Tools
Install-Bun
Write-Step "Done: $(& (Join-Path $BinDir 'nek.cmd') --version)"
Write-Host "Update later with 'nek update'. Channel: $Channel. Open a new terminal to use nek on PATH."
