# DeepAI Bridge installer / uninstaller.
#
# Double-click Install.cmd instead of running this by hand.
#
# What it does: finds (or downloads) Node.js, copies the app to
# %LOCALAPPDATA%\deepai-bridge\app, walks you through DeepAI sign-in, starts the
# bridge, adds it to OpenCode, and puts a shortcut on your desktop.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Yes -NoOpen -NoAutostart
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Yes,
  [switch]$NoOpen,
  [switch]$NoAutostart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$StoreDir  = Join-Path $env:LOCALAPPDATA 'deepai-bridge'
$AppDir    = Join-Path $StoreDir 'app'
$RuntimeDir = Join-Path $StoreDir 'runtime'
$SecretFile = Join-Path $StoreDir 'secrets.json'
$NodeFile   = Join-Path $StoreDir 'node-path.txt'
$LogFile    = Join-Path $StoreDir 'bridge.log'
$HealthUrl  = 'http://127.0.0.1:8788/health'
$RunKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName    = 'DeepAIBridge'
$ShortcutName = 'DeepAI Bridge.lnk'

# ---------------------------------------------------------------- output

function Say([string]$Message) { Write-Host $Message }
function Step([int]$Number, [string]$Text) {
  Write-Host ''
  Write-Host "  $Number. $Text" -ForegroundColor Cyan
}
function Good([string]$Message) { Write-Host "     $Message" -ForegroundColor Green }
function Note([string]$Message) { Write-Host "     $Message" -ForegroundColor DarkGray }
function Warn([string]$Message) { Write-Host "     $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { throw $Message }

function Confirm([string]$Question, [bool]$Default) {
  if ($Yes) { return $Default }
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  $answer = Read-Host "     $Question $hint"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return ($answer.Trim() -match '^(y|yes)$')
}

function Show-Banner([string]$Title) {
  Write-Host ''
  Write-Host '  ============================================' -ForegroundColor DarkGray
  Write-Host "   $Title" -ForegroundColor White
  Write-Host '  ============================================' -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------- discovery

function Get-NodePath {
  $candidates = New-Object System.Collections.Generic.List[string]
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $candidates.Add($found.Source) }
  $candidates.Add((Join-Path $RuntimeDir 'node.exe'))
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
  if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')) }
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))

  foreach ($path in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $version = & $path -p 'process.versions.node' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $version) { continue }
    try {
      if ([version]$version -ge [version]'20.11') { return $path }
    } catch { }
  }
  return $null
}

function Install-Node {
  $existing = Get-NodePath
  if ($existing) { return $existing }

  Note 'Node.js is not installed. Fetching a private copy (about 90 MB, once).'
  Note 'Nothing is installed system-wide and your PATH is not changed.'

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $target = Join-Path $RuntimeDir 'node.exe'
  $download = Join-Path $RuntimeDir 'node.download.exe'
  $urls = @(
    'https://nodejs.org/dist/latest-v24.x/win-x64/node.exe',
    'https://nodejs.org/dist/latest-v22.x/win-x64/node.exe',
    'https://nodejs.org/dist/latest/win-x64/node.exe'
  )

  foreach ($url in $urls) {
    try {
      if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
      Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing -TimeoutSec 900
      $version = & $download -p 'process.versions.node' 2>$null
      if ($LASTEXITCODE -eq 0 -and $version) {
        Move-Item -LiteralPath $download -Destination $target -Force
        Good "Downloaded Node.js $version"
        return $target
      }
      Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    } catch {
      Warn "Could not use $url"
    }
  }

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Note 'Trying winget instead.'
    try {
      & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    } catch { }
    $after = Get-NodePath
    if ($after) { Good 'Node.js installed with winget.'; return $after }
  }

  Fail @"
Could not get Node.js automatically.
Install the LTS build from https://nodejs.org (tick "Add to PATH"),
then run Install.cmd again.
"@
}

# ---------------------------------------------------------------- files

function Install-Files {
  $source = (Resolve-Path -LiteralPath $PSScriptRoot).Path
  $destination = [IO.Path]::GetFullPath($AppDir)
  if ($source.TrimEnd('\') -ieq $destination.TrimEnd('\')) {
    Note "Already running from the install folder."
    return
  }

  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  $items = @(
    'src', 'ui', 'scripts',
    'auth.mjs', 'doctor.mjs', 'smoke.mjs',
    'package.json', 'README.md', '.env.example', '.env',
    'DeepAI Bridge.vbs', 'start-hidden.vbs',
    'install.ps1', 'Install.cmd', 'Uninstall.cmd'
  )

  foreach ($item in $items) {
    $from = Join-Path $source $item
    if (-not (Test-Path -LiteralPath $from)) { continue }
    $to = Join-Path $AppDir $item
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
  }
}

function Get-SavedKey {
  if (-not (Test-Path -LiteralPath $SecretFile)) { return $null }
  try {
    $saved = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
    if ($saved.apiKey) { return $saved }
  } catch { }
  return $null
}

function Invoke-SignIn([string]$Node) {
  $saved = Get-SavedKey
  if ($saved) {
    Good ("Already signed in" + $(if ($saved.username) { " as $($saved.username)" } else { '' }) + '.')
    return $true
  }

  Note 'Your browser will open DeepAI. Sign in and approve the app.'
  $process = Start-Process -FilePath $Node `
    -ArgumentList 'auth.mjs' `
    -WorkingDirectory $AppDir `
    -PassThru -NoNewWindow

  if (-not $process.WaitForExit(300000)) {
    try { $process.Kill() } catch { }
    Fail 'Sign-in was not finished within 5 minutes. Run Install.cmd again when you are ready.'
  }
  if ($process.ExitCode -ne 0) {
    Fail 'DeepAI did not accept the sign-in. Run Install.cmd again to retry.'
  }

  $saved = Get-SavedKey
  if (-not $saved) { Fail 'Sign-in finished but no key was saved. Run Install.cmd again.' }
  Good ("Signed in" + $(if ($saved.username) { " as $($saved.username)" } else { '' }) + '.')
  return $true
}

# ---------------------------------------------------------------- bridge

function Test-Bridge {
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-BridgeProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src\\index\.mjs' }
}

function Start-Bridge {
  if (Test-Bridge) {
    $running = @(Get-BridgeProcesses)
    if ($running.Count -gt 0) {
      $restart = Confirm 'A bridge is already running. Restart it from the installed copy?' $true
      if (-not $restart) {
        Note 'Keeping the running bridge.'
        return
      }
      foreach ($process in $running) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 1
    }
  }

  $vbs = Join-Path $AppDir 'start-hidden.vbs'
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"')

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Bridge) { return }
  }

  $tail = ''
  if (Test-Path -LiteralPath $LogFile) {
    $tail = (Get-Content -LiteralPath $LogFile -Tail 12 -ErrorAction SilentlyContinue) -join "`n"
  }
  Fail @"
The bridge did not come up on port 8788.
Last log lines:
$tail
"@
}

function Invoke-Doctor([string]$Node) {
  Push-Location $AppDir
  try {
    & $Node doctor.mjs
    return ($LASTEXITCODE -eq 0)
  } finally {
    Pop-Location
  }
}

function Write-OpenCodeConfig([string]$Node) {
  if (-not (Confirm 'Add DeepAI models to OpenCode now?' $true)) {
    Note 'Skipped. Run npm run config:global inside the app folder later.'
    return $false
  }

  Push-Location $AppDir
  try {
    & $Node (Join-Path $AppDir 'scripts\gen-config.mjs') --global
    if ($LASTEXITCODE -ne 0) { Warn 'OpenCode config was not written.'; return $false }
  } catch {
    Warn "OpenCode config was not written: $($_.Exception.Message)"
    return $false
  } finally {
    Pop-Location
  }
  return $true
}

# ---------------------------------------------------------------- shell bits

function Get-IconPath {
  $candidates = @()
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  }
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) { return $path }
  }
  return (Join-Path $env:SystemRoot 'System32\shell32.dll')
}

function New-Shortcut([string]$Path) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments = '"' + (Join-Path $AppDir 'DeepAI Bridge.vbs') + '"'
  $shortcut.WorkingDirectory = $AppDir
  $shortcut.IconLocation = (Get-IconPath) + ',0'
  $shortcut.Description = 'Start the DeepAI bridge and open its control panel'
  $shortcut.Save()
}

function Install-Shortcuts {
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) $ShortcutName
  New-Shortcut $desktop
  Good "Desktop shortcut: $desktop"

  $programs = [Environment]::GetFolderPath('Programs')
  if ($programs) {
    $startMenu = Join-Path $programs 'DeepAI Bridge'
    New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
    New-Shortcut (Join-Path $startMenu $ShortcutName)
    Good "Start menu: $startMenu"
  }
}

function Remove-Tree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  # A launcher batch file can still be open for a moment; retry instead of failing.
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
}

function Set-AutostartEntry([bool]$Enabled) {
  New-Item -Path $RunKey -Force | Out-Null
  if ($Enabled) {
    $command = 'wscript.exe "' + (Join-Path $AppDir 'start-hidden.vbs') + '"'
    Set-ItemProperty -Path $RunKey -Name $RunName -Value $command
    Good 'Bridge will start hidden when you sign in.'
  } else {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Note 'Autostart is off. You can turn it on any time from the control panel.'
  }
}

# ---------------------------------------------------------------- install

function Install-Bridge {
  Show-Banner 'DeepAI Bridge setup'

  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'src\index.mjs'))) {
    Fail @"
This folder is incomplete, usually because the zip was opened instead of extracted.
Right-click the zip, choose Extract All, then double-click Install.cmd inside
the extracted folder.
"@
  }

  Step 1 'Checking Node.js'
  $node = Install-Node
  Good "Node.js $(& $node -p 'process.versions.node') at $node"

  New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null
  Set-Content -LiteralPath $NodeFile -Value $node -Encoding Default
  Note "Remembered at $NodeFile"

  Step 2 'Copying the app'
  Install-Files
  Good "Installed to $AppDir"
  Note 'The folder you are running this from can be deleted or moved afterwards.'

  Step 3 'Signing in to DeepAI'
  Invoke-SignIn $node | Out-Null

  Step 4 'Starting the bridge'
  Start-Bridge
  Good 'Bridge is up on http://127.0.0.1:8788'

  Step 5 'Checking the lane'
  $healthy = Invoke-Doctor $node
  if ($healthy) { Good 'Check-in, catalog and machine id all look right.' }
  else { Warn 'The self-check printed a problem above. The bridge is still running.' }

  Step 6 'Pointing OpenCode at it'
  $configured = $false
  if ($healthy) { $configured = Write-OpenCodeConfig $node }

  Step 7 'Adding shortcuts'
  Install-Shortcuts

  Step 8 'Startup'
  $autostart = $false
  if (-not $NoAutostart) {
    $autostart = Confirm 'Start the bridge automatically when you sign in to Windows?' $true
  }
  Set-AutostartEntry $autostart

  Write-Host ''
  Write-Host '  ============================================' -ForegroundColor DarkGray
  Write-Host '   DeepAI Bridge is installed.' -ForegroundColor Green
  Write-Host '  ============================================' -ForegroundColor DarkGray
  Write-Host ''
  Say "  Control panel   http://127.0.0.1:8788/"
  Say "  App window      double-click 'DeepAI Bridge' on your desktop"
  Say "  Log             $LogFile"
  Say "  App files       $AppDir"
  Write-Host ''
  if ($configured) {
    Say '  In OpenCode, pick a model from /models -> DeepAI.'
  } else {
    Say '  To add the models to OpenCode later, double-click Install.cmd again.'
  }
  if ($autostart) { Say '  The bridge will come up hidden next time you sign in.' }
  Write-Host ''

  if (-not $NoOpen) {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
      -ArgumentList ('"' + (Join-Path $AppDir 'DeepAI Bridge.vbs') + '"')
    Note 'Opening the control panel...'
  }
}

# ---------------------------------------------------------------- uninstall

function Uninstall-Bridge {
  Show-Banner 'DeepAI Bridge removal'

  Step 1 'Stopping the bridge'
  $running = @(Get-BridgeProcesses)
  foreach ($process in $running) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($running.Count -eq 0) { Note 'Nothing was running.' } else { Good "Stopped $($running.Count) process(es)." }

  Step 2 'Removing the logon entry'
  Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
  Good 'Logon entry removed.'

  Step 3 'Removing shortcuts'
  $shorts = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) $ShortcutName),
    (Join-Path ([Environment]::GetFolderPath('Programs')) ('DeepAI Bridge\' + $ShortcutName))
  )
  foreach ($path in $shorts) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepAI Bridge'
  if (Test-Path -LiteralPath $menu) { Remove-Item -LiteralPath $menu -Recurse -Force }
  Good 'Desktop and start menu shortcuts removed.'

  Step 4 'Removing files'
  $deleteAll = Confirm 'Also delete the saved DeepAI sign-in and logs?' $false
  if ($deleteAll) {
    Remove-Tree $StoreDir
    Good "Deleted $StoreDir"
  } else {
    Remove-Tree $AppDir
    Good "Deleted $AppDir (sign-in kept in $StoreDir)"
  }

  Write-Host ''
  Write-Host '  DeepAI Bridge has been removed.' -ForegroundColor Green
  Write-Host ''
  Say '  OpenCode still lists the DeepAI provider until you remove it:'
  Say '  delete the "deepai" entry under "providers" in'
  Say "  $env:USERPROFILE\.config\opencode\opencode.json"
  Write-Host ''

  # Uninstall.cmd runs this script from a copy in TEMP so the app folder can be
  # deleted underneath it; clean that copy up too.
  if ($PSCommandPath -and $PSCommandPath.StartsWith($env:TEMP, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- run

try {
  if ($Uninstall) { Uninstall-Bridge } else { Install-Bridge }
} catch {
  Write-Host ''
  Write-Host '  Setup stopped.' -ForegroundColor Red
  Write-Host ''
  foreach ($line in ("$($_.Exception.Message)" -split "`n")) {
    if ($line.Trim()) { Write-Host "  $($line.TrimEnd())" -ForegroundColor Yellow }
  }
  Write-Host ''
  exit 1
}
