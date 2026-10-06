# RealBud Windows QA harness. Windows PowerShell 5.1, no modules, run as the normal user.
# Read-only (GET only) except -Mode install, which downloads and silently installs RealBud.
# Never prints or saves the session token. Runbook: docs/WINDOWS-QA-RUNBOOK.md
#   & ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('http://192.168.64.1:8765/windows-qa.ps1'))) -Mode status
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-qa.ps1 -Mode install -ExpectedSha256 4b5c9c0b
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [string]$InstallerUrl = 'http://192.168.64.1:8765/RealBud-0.1.35-setup.exe',
  [string]$ExpectedSha256 = '',
  [ValidateSet('install', 'status', 'fresh-check')][string]$Mode = 'status',
  [string]$Out = (Join-Path ([Environment]::GetFolderPath('Desktop')) ('realbud-qa-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'))
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Budgets (docs/WINDOWS-QA-RUNBOOK.md). Emulated x64 on Arm is slower; confirm on a real x64 PC.
$WindowBudgetS = 120; $HealthBudgetS = 120; $LaunchGiveUpS = 300; $StallMs = 5000; $SlowMs = 1000
$DataDir = $(if ($env:REALBUD_DATA_DIR) { $env:REALBUD_DATA_DIR } else { Join-Path $env:USERPROFILE '.realbud' })
$LogDir = Join-Path $env:APPDATA 'RealBud\logs'
$started = Get-Date
$steps = New-Object System.Collections.ArrayList
$script:port = $null; $script:token = $null; $script:exe = $null

function Mask([string]$s) {
  if (-not $s) { return $s }
  $s = [regex]::Replace($s, [regex]::Escape($env:USERPROFILE), '%USERPROFILE%', 'IgnoreCase')
  $s = [regex]::Replace($s, '[A-Fa-f0-9]{48,}', '<hex>')
  $s = [regex]::Replace($s, '(?i)(token|secret|password|api[_-]?key|authorization)("?\s*[:=]\s*"?)[^\s",]+', '$1$2<masked>')
  [regex]::Replace($s, '(?i)bearer\s+\S+', 'Bearer <masked>')
}

# Each body returns @{ status = PASS|WARN|FAIL; note = one line; detail = data }. A throw is a FAIL.
function Step([string]$name, [scriptblock]$body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = [ordered]@{ name = $name; ok = $false; status = 'FAIL'; seconds = 0; note = ''; detail = $null }
  try { $res = & $body; $r.status = $res.status; $r.note = $res.note; $r.detail = $res.detail }
  catch { $r.note = Mask $_.Exception.Message }
  $r.ok = $r.status -ne 'FAIL'
  $r.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  [void]$steps.Add($r)
  $color = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red' }[$r.status]
  Write-Host ('{0,-4}  {1,-14} {2,6}s  {3}' -f $r.status, $name, $r.seconds, $r.note) -ForegroundColor $color
  $r
}

function Http([string]$path, [bool]$auth = $false, [int]$timeoutMs = 10000) {
  if (-not $script:port) { throw 'The RealBud service is not answering.' }
  if ($auth -and -not $script:token) { throw 'No session file for the running service; authed checks skipped.' }
  $req = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($script:port)$path")
  $req.Proxy = $null; $req.Timeout = $timeoutMs; $req.ReadWriteTimeout = $timeoutMs
  if ($auth) { $req.Headers.Add('x-realbud-session', $script:token) }
  $resp = $req.GetResponse()
  try { $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } finally { $resp.Close() }
  $text | ConvertFrom-Json
}

# The token is used only when the session file names the process answering health
# (same rule as shared/local-session.mjs localSessionFor).
function Find-Service {
  $sess = $null
  try { $sess = Get-Content -Raw -LiteralPath (Join-Path $DataDir 'local-auth\session.json') | ConvertFrom-Json } catch {}
  $ports = @(); if ($sess -and $sess.port) { $ports += [int]$sess.port }; $ports += 8799, 18799, 28799
  foreach ($p in ($ports | Select-Object -Unique)) {
    $script:port = $p
    try {
      $h = Http '/api/health' $false 3000
      if ($h.app -eq 'realbud') {
        $script:token = $(if ($sess -and $sess.pid -eq $h.pid -and [int]$sess.port -eq $p) { [string]$sess.token } else { $null })
        return $h
      }
    } catch {}
  }
  $script:port = $null; $script:token = $null; $null
}

function Find-App {
  $keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'RealBud*' }
  $dirs = @($keys | ForEach-Object { "$($_.InstallLocation)".Trim('"') } | Where-Object { $_ }) +
    (Join-Path $env:LOCALAPPDATA 'Programs\realbud'), (Join-Path $env:LOCALAPPDATA 'Programs\RealBud')
  foreach ($d in $dirs) { $e = Join-Path $d 'RealBud.exe'; if (Test-Path -LiteralPath $e) { return $e } }
  $null
}

function RuntimePathEntries {
  @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -like '*\.realbud\hermes\runtimes\*' })
}

Write-Host "RealBud Windows QA - mode $Mode - $(Get-Date -Format s)"

Step 'environment' {
  $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem
  $free = [math]::Round((Get-PSDrive $env:SystemDrive.TrimEnd(':')).Free / 1GB, 1)
  $lp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -ErrorAction SilentlyContinue).LongPathsEnabled
  $ci = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue
  $sac = $(if ($ci -and $null -ne $ci.VerifiedAndReputablePolicyState) { @{ 0 = 'off'; 1 = 'on'; 2 = 'evaluation' }[[int]$ci.VerifiedAndReputablePolicyState] } else { 'not reported' })
  $d = [ordered]@{
    windows = $os.Caption; build = $os.BuildNumber; osArch = $os.OSArchitecture
    cpuArch = $(if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE })
    cpus = $cs.NumberOfLogicalProcessors; ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    freeGbSystemDrive = $free; longPathsEnabled = [int]$lp; smartAppControl = $sac; sMode = ([int]$ci.SkuPolicyRequired -eq 1)
    profilePathLength = $env:USERPROFILE.Length; usernameHasSpaces = $env:USERNAME.Contains(' ')
    powershell = $PSVersionTable.PSVersion.ToString()
  }
  $warn = @()
  if ($free -lt 20) { $warn += "only $free GB free" }
  if ($sac -eq 'on' -or $sac -eq 'evaluation') { $warn += "Smart App Control $sac (blocks the unsigned installer)" }
  if ($d.sMode) { $warn += 'S mode' }
  $note = "$($d.windows) build $($d.build) $($d.cpuArch), $($d.cpus) CPU, $($d.ramGb) GB RAM, $free GB free, LongPaths=$($d.longPathsEnabled), spaces in user=$($d.usernameHasSpaces)"
  @{ status = $(if ($warn) { 'WARN' } else { 'PASS' }); note = (@($warn) + $note) -join '; '; detail = $d }
} | Out-Null

if ($Mode -eq 'fresh-check') {
  Step 'fresh-profile' {
    $d = [ordered]@{
      dataDirExists = (Test-Path -LiteralPath $DataDir); appInstalled = [bool](Find-App)
      realbudProcesses = @(Get-Process RealBud -ErrorAction SilentlyContinue).Count; runtimePathEntries = (RuntimePathEntries).Count
      logDirExists = (Test-Path -LiteralPath $LogDir)
    }
    $dirty = @($d.Keys | Where-Object { $d[$_] -and $d[$_] -ne 0 })
    @{ status = $(if ($dirty) { 'WARN' } else { 'PASS' }); note = $(if ($dirty) { 'not fresh: ' + ($dirty -join ', ') } else { 'clean profile, nothing installed' }); detail = $d }
  } | Out-Null
}

$proceed = $true
if ($Mode -eq 'install') {
  $dl = Step 'download' {
    if (Test-Path -LiteralPath $InstallerUrl) { $script:installer = (Resolve-Path -LiteralPath $InstallerUrl).Path }
    else {
      $script:installer = Join-Path $env:TEMP ([IO.Path]::GetFileName(([uri]$InstallerUrl).AbsolutePath))
      Invoke-WebRequest -Uri $InstallerUrl -OutFile $script:installer -UseBasicParsing
    }
    $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $script:installer).Hash.ToLowerInvariant()
    $motw = [bool](Get-Item -LiteralPath $script:installer -Stream Zone.Identifier -ErrorAction SilentlyContinue)
    $match = (-not $ExpectedSha256) -or $sha.StartsWith($ExpectedSha256.ToLowerInvariant())
    $mb = [math]::Round((Get-Item -LiteralPath $script:installer).Length / 1MB, 1)
    @{ status = $(if (-not $match) { 'FAIL' } elseif (-not $ExpectedSha256) { 'WARN' } else { 'PASS' })
       note = "sha256 $($sha.Substring(0, 12)) $(if ($ExpectedSha256) { if ($match) { 'matches' } else { 'DOES NOT match ' + $ExpectedSha256 } } else { '(no -ExpectedSha256 given)' }), $mb MB, MOTW=$motw"
       detail = [ordered]@{ file = [IO.Path]::GetFileName($script:installer); mb = $mb; sha256 = $sha; expectedPrefix = $ExpectedSha256; markOfTheWeb = $motw } }
  }
  $proceed = $dl.ok
  if ($proceed) {
    $inst = Step 'install' {
      $running = @(Get-Process RealBud -ErrorAction SilentlyContinue)
      if ($running) {
        # Polite close first, as the NSIS installer does (2>&1 on a native command throws under Stop in 5.1).
        Start-Process taskkill.exe -ArgumentList '/im RealBud.exe /t' -WindowStyle Hidden -Wait
        for ($i = 0; $i -lt 20 -and (Get-Process RealBud -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
        Get-Process RealBud -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
      }
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $p = Start-Process -FilePath $script:installer -ArgumentList '/S' -PassThru
      $null = $p.Handle  # without a cached handle, ExitCode can come back empty
      if (-not $p.WaitForExit(900000)) { throw 'Installer exceeded 15 minutes.' }
      $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
      $script:exe = Find-App
      $ver = $(if ($script:exe) { (Get-Item -LiteralPath $script:exe).VersionInfo.ProductVersion })
      @{ status = $(if ($p.ExitCode -eq 0 -and $script:exe) { 'PASS' } else { 'FAIL' })
         note = "silent install $secs s, exit $($p.ExitCode), stopped $($running.Count) RealBud process(es), installed $ver"
         detail = [ordered]@{ installSeconds = $secs; exitCode = $p.ExitCode; stoppedProcesses = $running.Count; exe = (Mask $script:exe); productVersion = $ver } }
    }
    $proceed = $inst.ok
  }
  if ($proceed) {
    Step 'launch' {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      Start-Process explorer.exe -ArgumentList ('"' + $script:exe + '"')  # explorer starts it non-elevated
      $win = $null; $health = $null
      while ($sw.Elapsed.TotalSeconds -lt $LaunchGiveUpS -and -not ($win -and $health)) {
        if (-not $win -and (Get-Process RealBud -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) { $win = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
        if (-not $health -and (Find-Service)) { $health = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
        Start-Sleep -Milliseconds 500
      }
      $status = $(if (-not $health) { 'FAIL' } elseif (-not $win -or $win -gt $WindowBudgetS -or $health -gt $HealthBudgetS) { 'WARN' } else { 'PASS' })
      @{ status = $status; note = "first window $(if ($win) { "$win s" } else { 'not seen' }) (budget $WindowBudgetS), first health $(if ($health) { "$health s" } else { "none in $LaunchGiveUpS s" }) (budget $HealthBudgetS)"
         detail = [ordered]@{ secondsToFirstWindow = $win; secondsToFirstHealth = $health; port = $script:port } }
    } | Out-Null
  }
}

if ($proceed -and $Mode -ne 'fresh-check') {
  Step 'service' {
    $h = Find-Service
    if (-not $h) { throw 'No RealBud service answers /api/health on 8799, 18799 or 28799.' }
    if (-not $script:exe) { $script:exe = Find-App }
    $ver = $(if ($script:exe) { (Get-Item -LiteralPath $script:exe).VersionInfo.ProductVersion })
    $same = $ver -and ($ver -eq $h.version -or $ver.StartsWith("$($h.version)."))
    @{ status = $(if ($same -and $script:token) { 'PASS' } else { 'WARN' })
       note = "health on $($script:port): version $($h.version), installed $ver$(if (-not $same) { ' MISMATCH' }), busy=$($h.busy), session file $(if ($script:token) { 'matches' } else { 'missing or stale' })"
       detail = [ordered]@{ port = $script:port; healthVersion = $h.version; installedVersion = $ver; busy = $h.busy; staticUi = $h.static; sessionMatches = [bool]$script:token } }
  } | Out-Null

  Step 'bud' {
    $hs = Http '/api/hermes' $true 30000
    $job = (Http '/api/hermes/install/status' $true).install
    $link = Http '/api/office-link' $true
    $why = $(if ($hs.ready) { 'ready' } elseif ($job.state -eq 'failed') { "setup failed: $($job.error)" } elseif ($hs.autoSetup.detail) { $hs.autoSetup.detail } else { $hs.detail })
    $d = [ordered]@{
      budReady = [bool]$hs.ready; why = (Mask $why); detail = (Mask $hs.detail); cliInstalled = $hs.cli.installed; cliMatchesPin = $hs.cli.matchesPin
      packInstalled = $hs.pack.installed; modelAttached = $hs.model.attached; modelWithdrawn = $hs.modelAccess.withdrawn
      autoSetup = [ordered]@{ state = $hs.autoSetup.state; code = $hs.autoSetup.code; step = $hs.autoSetup.step; total = $hs.autoSetup.total; detail = (Mask $hs.autoSetup.detail) }
      install = [ordered]@{ state = $job.state; progress = (Mask $job.progress.detail); error = (Mask $job.error); failureKind = $job.failureKind }
      office = [ordered]@{ state = $link.state; provisioned = $link.provisioned; serviceWithdrawn = $link.serviceWithdrawn; modelKey = $link.modelKey; provisioningSkipped = $link.provisioningSkipped; usage = $link.usage.state }
    }
    @{ status = $(if ($hs.ready) { 'PASS' } elseif ($job.state -eq 'failed') { 'FAIL' } else { 'WARN' })
       note = "Bud ready: $(if ($hs.ready) { 'yes' } else { 'no' }) ($($d.why)); office $($link.state), model access $(if ($link.provisioned) { 'yes' } else { 'no' }); setup $($job.state)"
       detail = $d }
  } | Out-Null

  Step 'latency' {
    $ms = @(); $failed = 0; $busy = 0
    for ($i = 0; $i -lt 20; $i++) {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      try { $h = Http '/api/health' $false 30000; if ($h.busy) { $busy++ }; $ms += [int]$sw.ElapsedMilliseconds } catch { $failed++; $ms += [int]$sw.ElapsedMilliseconds }
      $rest = 1000 - [int]$sw.ElapsedMilliseconds; if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
    }
    $sorted = @($ms | Sort-Object); $max = $sorted[-1]; $p95 = $sorted[[int][math]::Ceiling(0.95 * $sorted.Count) - 1]
    @{ status = $(if ($failed -or $max -gt $StallMs) { 'FAIL' } elseif ($max -gt $SlowMs) { 'WARN' } else { 'PASS' })
       note = "20 samples: max $max ms, p95 $p95 ms, failed $failed, busy $busy (stall limit $StallMs ms)"
       detail = [ordered]@{ samplesMs = $ms; maxMs = $max; p95Ms = $p95; failed = $failed; busySamples = $busy } }
  } | Out-Null
}

if ($Mode -ne 'fresh-check') {
  Step 'logs' {
    $d = [ordered]@{}; $hits = 0; $missing = @()
    foreach ($rel in 'server.log', 'office-service\stdout-stderr.log') {
      $f = Join-Path $LogDir $rel
      if (-not (Test-Path -LiteralPath $f)) { $missing += $rel; continue }
      $m = @(Get-Content -LiteralPath $f -Tail 2000 | Select-String -CaseSensitive -Pattern 'stage failed|could not answer|runtime check|ERROR' |
        Select-Object -Last 25 | ForEach-Object { $l = Mask $_.Line; if ($l.Length -gt 300) { $l.Substring(0, 300) } else { $l } })
      $hits += $m.Count
      $d[$rel] = [ordered]@{ kb = [math]::Round((Get-Item -LiteralPath $f).Length / 1KB); lastWrite = (Get-Item -LiteralPath $f).LastWriteTime.ToString('s'); matches = $m }
    }
    @{ status = $(if ($hits -or $missing) { 'WARN' } else { 'PASS' }); note = "$hits flagged line(s)$(if ($missing) { '; missing ' + ($missing -join ', ') })"; detail = $d }
  } | Out-Null

  Step 'runtimes' {
    $root = Join-Path $DataDir 'hermes\runtimes'
    $dirs = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $selected = $null; try { $selected = (Get-Content -Raw -LiteralPath (Join-Path $DataDir 'hermes\realbud-runtime.json') | ConvertFrom-Json).selected } catch {}
    $entries = RuntimePathEntries
    $stale = @($entries | Where-Object { -not $selected -or $_ -notlike "*\runtimes\$selected\*" -or -not (Test-Path -LiteralPath $_) })
    # ponytail: Get-ChildItem may miss files past MAX_PATH, so size is a lower bound when unreadable > 0.
    $errs = $null; $bytes = (Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue -ErrorVariable errs | Measure-Object Length -Sum).Sum
    $d = [ordered]@{ folders = $dirs; selected = $selected; selectedExists = [bool]($selected -and $dirs -contains $selected)
      userPathEntries = $entries.Count; stalePathEntries = @($stale | ForEach-Object { Mask $_ }); sizeMb = [math]::Round($bytes / 1MB); unreadable = @($errs).Count }
    @{ status = $(if ($dirs.Count -gt 1 -or $stale -or ($selected -and -not $d.selectedExists)) { 'WARN' } else { 'PASS' })
       note = "$($dirs.Count) runtime folder(s), selected $(if ($selected) { $selected.Substring(0, 12) } else { 'none' }), $($entries.Count) PATH entries ($($stale.Count) stale), $($d.sizeMb) MB"
       detail = $d }
  } | Out-Null
}

$overall = $(if ($steps | Where-Object { $_.status -eq 'FAIL' }) { 'FAIL' } elseif ($steps | Where-Object { $_.status -eq 'WARN' }) { 'WARN' } else { 'PASS' })
$receipt = [ordered]@{
  tool = 'scripts/windows-qa.ps1'; receiptVersion = 1; mode = $Mode; result = $overall
  startedAt = $started.ToString('o'); finishedAt = (Get-Date).ToString('o'); evidenceTier = 'installed device'
  limits = @('One computer, one run. An emulated x64-on-Arm VM gives pessimistic timings.',
    'Read-only checks; onboarding, link code, packs, Gmail and workflows are manual (docs/WINDOWS-QA-RUNBOOK.md).',
    'Paths are masked and the session token is never recorded. Not customer acceptance.')
  steps = $steps
}
[IO.File]::WriteAllText($Out, ($receipt | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
Write-Host ''
Write-Host "Overall: $overall  ($(@($steps | Where-Object { $_.status -eq 'PASS' }).Count) pass, $(@($steps | Where-Object { $_.status -eq 'WARN' }).Count) warn, $(@($steps | Where-Object { $_.status -eq 'FAIL' }).Count) fail)"
Write-Host "Receipt: $(Mask $Out)"
$script:token = $null  # under the one-line scriptblock form this scope is the caller's session
if ($PSCommandPath -and $overall -eq 'FAIL') { exit 1 }
