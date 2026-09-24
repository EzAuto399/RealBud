param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ReceiptDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or -not $IsWindows) {
  throw 'Run this installer acceptance probe only on a disposable Windows CI host.'
}
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'RealBud' }
if ($existing) { throw 'RealBud is already installed; refusing to replace an existing installation.' }
$sourceRevision = [string]$env:REALBUD_BUILD_SHA
if ($sourceRevision -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'REALBUD_BUILD_SHA must identify the full source commit used to build this installer.'
}
$sourceRevision = $sourceRevision.ToLowerInvariant()
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$ReceiptDirectory = [IO.Path]::GetFullPath($ReceiptDirectory)
if (Test-Path -LiteralPath $ReceiptDirectory) {
  if (-not (Test-Path -LiteralPath $ReceiptDirectory -PathType Container) -or
      @(Get-ChildItem -Force -LiteralPath $ReceiptDirectory).Count -ne 0) {
    throw 'ReceiptDirectory must be empty so this run cannot claim earlier probe receipts.'
  }
}
New-Item -ItemType Directory -Force -Path $ReceiptDirectory | Out-Null
$installerIdentity = [ordered]@{
  file = [IO.Path]::GetFileName($Installer)
  bytes = (Get-Item -LiteralPath $Installer).Length
  sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
}
$installRoot = Join-Path $env:RUNNER_TEMP ('RealBud installed probe ' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $installRoot 'RealBud.exe'
$resources = Join-Path $installRoot 'resources'
$installation = [ordered]@{ started = $false; exitCode = $null; appCreated = $false }
$uninstall = [ordered]@{
  attempted = $false; exitCode = $null; appRemoved = $false; resourcesRemoved = $false
  passed = $false; failure = $null
}
$probeStage = 'install'
$probePassed = $false
$probeFailure = $null
$cleanupFailure = $null
$receiptFailure = $null
$gui = [ordered]@{ started = $false; windowObserved = $false; rendererReady = $false; exitCode = $null; passed = $false }
try {
  # NSIS requires /D last and consumes the remainder, including spaces.
  $installation.started = $true
  $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installRoot) -PassThru
  if (-not $setup.WaitForExit(120000)) { $setup.Kill(); throw 'Installer exceeded two minutes.' }
  $installation.exitCode = $setup.ExitCode
  $installation.appCreated = Test-Path -LiteralPath $app -PathType Leaf
  if ($installation.exitCode -ne 0) { throw "Installer failed: $($installation.exitCode)" }
  if (-not $installation.appCreated) { throw 'Installer did not create the selected isolated destination.' }
  $probeStage = 'installed-helpers'
  $env:ELECTRON_RUN_AS_NODE = '1'
  $script = Join-Path $PSScriptRoot 'smoke-windows-package.mjs'
  $receipt = Join-Path $ReceiptDirectory 'installed-windows.json'
  $arguments = '"' + $script + '" "' + $resources + '" "' + $receipt + '"'
  $probe = Start-Process -FilePath $app -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'installed-windows.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'installed-windows.stderr.log')
  if (-not $probe.WaitForExit(120000)) { $probe.Kill(); throw 'Installed helper probe exceeded two minutes.' }
  if ($probe.ExitCode -ne 0) { throw "Installed helper probe failed: $($probe.ExitCode)" }
  if (-not (Test-Path -LiteralPath $receipt)) { throw 'Installed probe did not write its receipt.' }
  $result = Get-Content -Raw -LiteralPath $receipt | ConvertFrom-Json
  if (-not $result.passed) { throw 'Installed probe did not pass.' }
  $result.checks | Write-Output
  # Exercise the exact installed candidate module with the CI runner's Python.
  # This proves packaged helper bytes/API only; it does not admit memory writes
  # or claim the Hermes-managed Python/runtime and journal integration passed.
  # Hosted runners expose several python applications on PATH (hostedtoolcache, the Store alias); take the first.
  $probeStage = 'installed-memory-primitives'
  $python = @(Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1)[0].Source
  $memoryScript = Join-Path $PSScriptRoot 'testing/hermes-memory-windows-native.py'
  $memoryModule = Join-Path $resources 'server/helpers/hermes-memory-windows-native.py'
  $memoryReceipt = Join-Path $ReceiptDirectory 'installed-memory-primitives.json'
  if (-not (Test-Path -LiteralPath $memoryModule -PathType Leaf)) { throw 'Installed native memory candidate is missing.' }
  $memoryArguments = '"' + $memoryScript + '" --module "' + $memoryModule + '" --receipt "' + $memoryReceipt + '"'
  $memoryProbe = Start-Process -FilePath $python -ArgumentList $memoryArguments -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'installed-memory-primitives.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'installed-memory-primitives.stderr.log')
  # The native acceptance script budgets 480 s for a cold PowerShell 5.1 runner; allow it to finish and write its receipt.
  if (-not $memoryProbe.WaitForExit(600000)) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $memoryProbe.Id /T /F | Out-Null
    throw 'Installed memory primitives exceeded ten minutes.'
  }
  # The native memory candidate is a documented production hold: its receipt is the evidence.
  # A refusal here is recorded and reported, and must not hide the service and backup probes that follow.
  if ($memoryProbe.ExitCode -ne 0) { Write-Warning "Installed memory primitives candidate failed: $($memoryProbe.ExitCode) (held candidate; see installed-memory-primitives.json)" }
  if (-not (Test-Path -LiteralPath $memoryReceipt)) { throw 'Installed memory primitives did not write a receipt.' }
  $memoryResult = Get-Content -Raw -LiteralPath $memoryReceipt | ConvertFrom-Json
  if (-not $memoryResult.passed) { Write-Warning ('Installed memory candidate did not pass (held): ' + $memoryResult.active_check + ' ' + ($memoryResult.native_error | ConvertTo-Json -Compress)) }
  if (-not $memoryResult.native_validation -or $memoryResult.platform -ne 'win32' -or -not $memoryResult.cleanup -or -not $memoryResult.handles_drained) {
    throw 'Installed memory candidate did not confirm native checks and cleanup.'
  }
  if ([IO.Path]::GetFullPath($memoryResult.selected_module) -ne [IO.Path]::GetFullPath($memoryModule)) { throw 'Memory receipt names a different module.' }
  if ($memoryResult.module_sha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $memoryModule).Hash.ToLowerInvariant()) { throw 'Installed memory module changed.' }
  $memoryResult.checks | Write-Output
  # Evidence for the installed service's PowerShell cost: run 35748277547 paid
  # ~23 s per successful launch inside the installed Electron-as-Node service
  # while the same launch under node.exe on the same runner took 0.2 s. Time a
  # trivial launch with the installed binary as the parent, and record the
  # Defender posture, before the service probe so a slow launch has a suspect.
  $probeStage = 'powershell-diagnostics'
  $launchProbe = Join-Path $PSScriptRoot 'testing' 'probe-windows-powershell-env.mjs'
  $launchProbeProcess = Start-Process -FilePath $app -ArgumentList ('"' + $launchProbe + '"') -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'installed-powershell-launch.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'installed-powershell-launch.stderr.log')
  if (-not $launchProbeProcess.WaitForExit(600000)) { $launchProbeProcess.Kill(); Write-Warning 'Installed PowerShell launch probe exceeded ten minutes.' }
  else { Get-Content -LiteralPath (Join-Path $ReceiptDirectory 'installed-powershell-launch.stdout.log') | Write-Output }
  try {
    $defender = Get-MpComputerStatus | Select-Object AMServiceEnabled, RealTimeProtectionEnabled, BehaviorMonitorEnabled, OnAccessProtectionEnabled, AntivirusSignatureAge
    $defenderPreference = Get-MpPreference | Select-Object MAPSReporting, CloudBlockLevel, CloudExtendedTimeout, DisableRealtimeMonitoring, DisableBehaviorMonitoring, DisableScriptScanning
    @{ status = $defender; preference = $defenderPreference } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $ReceiptDirectory 'installed-defender.json')
    Write-Output ('Defender: ' + ($defender | ConvertTo-Json -Compress) + ' ' + ($defenderPreference | ConvertTo-Json -Compress))
  } catch { Write-Warning ('Defender status unavailable: ' + $_.Exception.GetType().FullName) }
  # Load the installed compiled service using installed Electron/Node, with a
  # fresh home and no checkout node_modules or inherited provider credentials.
  $probeStage = 'installed-service'
  $serviceScript = Join-Path $PSScriptRoot 'smoke-company-bundle.mjs'
  $serviceReceipt = Join-Path $ReceiptDirectory 'installed-service.json'
  $serviceArguments = '"' + $serviceScript + '" "' + $serviceReceipt + '" "' + $resources + '"'
  # The smoke's default 25 s budget is for developer machines. A traced boot pays
  # eleven sequential powershell.exe admissions before it listens: seconds once
  # each one succeeds, but the whole window while each failed after ~35 s on
  # Set-Acl/Get-Acl module auto-load, which is how run 35740638732 reached its
  # watchdog with an empty stderr. The receipt now records the launches the
  # service actually made, its stdout and boot log, and a per-second health
  # timeline, so a repeat says which of the two it was.
  $env:REALBUD_SMOKE_READY_MS = '120000'
  $serviceProbe = Start-Process -FilePath $app -ArgumentList $serviceArguments -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'installed-service.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'installed-service.stderr.log')
  # The 120 s readiness window above, plus the read-only ACL witness that follows
  # it and the probe's own cleanup. The probe writes its receipt even when
  # readiness never arrives, so this outer kill — which destroys that receipt —
  # stays the last resort rather than the usual failure path.
  if (-not $serviceProbe.WaitForExit(240000)) { $serviceProbe.Kill(); throw 'Installed service probe exceeded four minutes.' }
  if ($serviceProbe.ExitCode -ne 0) { throw "Installed service probe failed: $($serviceProbe.ExitCode)" }
  if (-not (Test-Path -LiteralPath $serviceReceipt)) { throw 'Installed service probe did not write its receipt.' }
  $serviceResult = Get-Content -Raw -LiteralPath $serviceReceipt | ConvertFrom-Json
  if (-not $serviceResult.passed) { throw 'Installed service probe did not pass.' }
  $serviceResult.checks | Write-Output
  # Exercise the installed backup/restore API and cold-start guards without a
  # browser dependency. The script owns its disposable data and child services.
  $probeStage = 'installed-private-backup'
  $backupScript = Join-Path $PSScriptRoot 'qa-private-backup-boundaries.mjs'
  $backupReceipt = Join-Path $ReceiptDirectory 'installed-private-backup.json'
  $env:REALBUD_QA_RESOURCES = $resources
  $env:REALBUD_QA_EXECUTABLE = $app
  $env:QA_OUTPUT = $backupReceipt
  $backupProbe = Start-Process -FilePath $app -ArgumentList ('"' + $backupScript + '"') -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'installed-private-backup.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'installed-private-backup.stderr.log')
  if (-not $backupProbe.WaitForExit(120000)) {
    # Terminate only this known probe and the services it spawned. On Windows a
    # forceful parent termination cannot rely on JavaScript finally cleanup.
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $backupProbe.Id /T /F | Out-Null
    throw 'Installed private-backup probe exceeded two minutes.'
  }
  if ($backupProbe.ExitCode -ne 0) { throw "Installed private-backup probe failed: $($backupProbe.ExitCode)" }
  if (-not (Test-Path -LiteralPath $backupReceipt)) { throw 'Installed private-backup probe did not write its receipt.' }
  $backupResult = Get-Content -Raw -LiteralPath $backupReceipt | ConvertFrom-Json
  if (-not $backupResult.passed -or $backupResult.mode -ne 'packaged' -or $backupResult.platform -ne 'win32' -or -not $backupResult.runtime.electron) {
    throw 'Installed private-backup probe did not confirm its packaged Windows runtime.'
  }
  if ([IO.Path]::GetFullPath($backupResult.resources) -ne [IO.Path]::GetFullPath($resources)) { throw 'Private-backup receipt names a different resources directory.' }
  if ([IO.Path]::GetFullPath($backupResult.executable) -ne [IO.Path]::GetFullPath($app)) { throw 'Private-backup receipt names a different application executable.' }
  $backupResult.checks | Write-Output
  # The helpers above run RealBud.exe as Node. Prove the installed executable
  # also starts Electron's desktop process, owns a visible Windows window, and
  # loads its real packaged renderer/preload against the embedded office service.
  # The existing smoke hook closes the window and stops its disposable service.
  $probeStage = 'installed-gui'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $guiScratch = Join-Path $env:RUNNER_TEMP ('RealBud GUI probe ' + [guid]::NewGuid().ToString('N'))
  $guiProfile = Join-Path $guiScratch 'profile'
  $guiData = Join-Path $guiScratch 'data'
  $guiLogs = Join-Path $guiScratch 'logs'
  New-Item -ItemType Directory -Force -Path $guiProfile, $guiData, $guiLogs | Out-Null
  $guiReceipt = Join-Path $ReceiptDirectory 'installed-gui.json'
  $env:REALBUD_DATA_DIR = $guiData
  $env:REALBUD_LOG_DIR = $guiLogs
  $env:OMB_SMOKE_TEST = '1'
  $env:OMB_SMOKE_RESULT_FILE = $guiReceipt
  $guiProcess = Start-Process -FilePath $app -ArgumentList ('--user-data-dir="' + $guiProfile + '"') -PassThru
  $gui.started = $true
  $guiDeadline = [DateTime]::UtcNow.AddSeconds(240)
  do {
    $guiProcess.Refresh()
    if (-not $guiProcess.HasExited -and $guiProcess.MainWindowHandle -ne [IntPtr]::Zero) {
      $gui.windowObserved = $true
    }
    if ($guiProcess.HasExited) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $guiDeadline)
  if (-not $guiProcess.HasExited) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $guiProcess.Id /T /F | Out-Null
    throw 'Installed GUI did not exit within four minutes; see installed-gui-observation.json.'
  }
  $gui.exitCode = $guiProcess.ExitCode
  if (-not (Test-Path -LiteralPath $guiReceipt -PathType Leaf)) { throw 'Installed GUI did not write its renderer receipt.' }
  $guiResult = Get-Content -Raw -LiteralPath $guiReceipt | ConvertFrom-Json
  $gui.rendererReady = [bool]$guiResult.ok
  if (-not $gui.windowObserved) { throw 'Installed GUI renderer ran without an observed Windows top-level window.' }
  if (-not $gui.rendererReady) { throw 'Installed GUI renderer smoke failed; see installed-gui.json.' }
  if ($gui.exitCode -ne 0) { throw "Installed GUI exited with code $($gui.exitCode)." }
  if ($guiResult.result.title -ne 'RealBud' -or $guiResult.result.capabilities.host.platform -ne 'win32' -or
      $guiResult.result.health.app -ne 'realbud' -or $guiResult.result.health.static -ne $true -or
      $guiResult.result.company.remoteJoinAvailable -ne $true -or
      $guiResult.result.location -notmatch '^http://127\.0\.0\.1:\d+/$') {
    throw 'Installed GUI renderer receipt did not confirm the RealBud desktop, local service, and join surface.'
  }
  $gui.passed = $true
  Write-Output 'Installed RealBud desktop opened a Windows window and loaded its renderer, preload bridge, local service, and join surface.'
  $probePassed = $true
} catch {
  # Save the original ErrorRecord: cleanup must never replace a probe failure.
  $probeFailure = $_
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_RESOURCES -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_EXECUTABLE -ErrorAction SilentlyContinue
  Remove-Item Env:QA_OUTPUT -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_LOG_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:OMB_SMOKE_TEST -ErrorAction SilentlyContinue
  Remove-Item Env:OMB_SMOKE_RESULT_FILE -ErrorAction SilentlyContinue
  try {
    $guiLog = if ($guiLogs) { Join-Path $guiLogs 'server.log' } else { $null }
    $guiLogInfo = if ($guiLog -and (Test-Path -LiteralPath $guiLog -PathType Leaf)) { Get-Item -LiteralPath $guiLog } else { $null }
    $guiLogTail = if ($guiLogInfo) { (Get-Content -LiteralPath $guiLog -Tail 60) -join "`n" } else { '' }
    $guiEvidence = [ordered]@{
      schema = 1
      kind = 'realbud-installed-windows-gui-observation'
      sourceRevision = $sourceRevision
      executableSha256 = $(if (Test-Path -LiteralPath $app -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash.ToLowerInvariant() } else { $null })
      process = $gui
      log = [ordered]@{
        created = $null -ne $guiLogInfo
        bytes = $(if ($guiLogInfo) { $guiLogInfo.Length } else { $null })
        sha256 = $(if ($guiLogInfo) { (Get-FileHash -Algorithm SHA256 -LiteralPath $guiLog).Hash.ToLowerInvariant() } else { $null })
        serviceSpawned = $guiLogTail -match 'spawned pid='
        officeAnswered = $guiLogTail -match 'office service answered'
        deskLoadFailed = $guiLogTail -match 'desk failed to load'
      }
      limit = 'Packaged smoke mode on a disposable Windows CI runner; normal customer launch and Windows 11 remain unverified.'
    }
    $guiEvidence | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $ReceiptDirectory 'installed-gui-observation.json')
  } catch { Write-Warning ('GUI observation receipt unavailable: ' + $_.Exception.GetType().FullName) }
  try {
    $uninstaller = Join-Path $installRoot 'Uninstall RealBud.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      $uninstall.attempted = $true
      $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
      if (-not $remove.WaitForExit(60000)) {
        $uninstall.failure = 'launcher-timeout'
        $remove.Kill()
        throw 'Probe uninstaller launcher exceeded one minute.'
      }
      $uninstall.exitCode = $remove.ExitCode
      # NSIS may exit its launcher before its copied uninstaller finishes.
      # Observe only the unique disposable install root, never a user data path.
      $removalDeadline = [DateTime]::UtcNow.AddSeconds(60)
      do {
        $uninstall.appRemoved = -not (Test-Path -LiteralPath $app)
        $uninstall.resourcesRemoved = -not (Test-Path -LiteralPath $resources)
        if ($uninstall.appRemoved -and $uninstall.resourcesRemoved) { break }
        Start-Sleep -Milliseconds 250
      } while ([DateTime]::UtcNow -lt $removalDeadline)
      if ($uninstall.exitCode -ne 0) {
        $uninstall.failure = 'nonzero-exit'
        throw "Probe uninstaller failed: $($uninstall.exitCode)"
      }
    } else {
      $uninstall.appRemoved = -not (Test-Path -LiteralPath $app)
      $uninstall.resourcesRemoved = -not (Test-Path -LiteralPath $resources)
      if ($installation.appCreated -or -not ($uninstall.appRemoved -and $uninstall.resourcesRemoved)) {
        $uninstall.failure = 'missing-uninstaller'
        throw 'The disposable installation has no uninstaller to verify.'
      }
    }
    if (-not ($uninstall.appRemoved -and $uninstall.resourcesRemoved)) {
      $uninstall.failure = 'removal-timeout'
      throw 'Probe uninstall did not remove the installed app and resources within one minute.'
    }
    $uninstall.passed = $true
  } catch {
    $cleanupFailure = $_
    if (-not $uninstall.failure) { $uninstall.failure = 'unexpected-error' }
  }
  try {
    $linkedReceipts = @()
    foreach ($name in @('installed-windows.json', 'installed-memory-primitives.json', 'installed-service.json', 'installed-private-backup.json', 'installed-gui.json', 'installed-gui-observation.json')) {
      $childReceipt = Join-Path $ReceiptDirectory $name
      if (Test-Path -LiteralPath $childReceipt -PathType Leaf) {
        $linkedReceipts += [ordered]@{
          file = $name
          sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $childReceipt).Hash.ToLowerInvariant()
        }
      }
    }
    $lifecycle = [ordered]@{
      schema = 1
      kind = 'realbud-installed-windows-lifecycle'
      generatedAt = [DateTime]::UtcNow.ToString('o')
      passed = $probePassed -and $uninstall.passed
      proofLayer = 'installed-runtime-on-disposable-windows-ci'
      sourceRevision = $sourceRevision
      installer = $installerIdentity
      installation = $installation
      probes = [ordered]@{ passed = $probePassed; gui = $gui; receipts = $linkedReceipts }
      uninstall = $uninstall
      failureStage = $(if ($probeFailure) { $probeStage } elseif ($cleanupFailure) { 'uninstall' } else { $null })
      limits = @(
        'Fresh disposable installation only; no upgrade or customer Windows device acceptance.'
        'Uninstall verifies app and resources removal only; no user-data preservation claim.'
        'Source revision is supplied by the build workflow and bound here to the installer and probe receipt hashes.'
        'Native memory admission remains held; inspect the linked primitive receipt separately.'
        'GUI proof uses packaged smoke mode on Windows CI; normal customer launch and Windows 11 remain unverified.'
      )
    }
    $lifecycle | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $ReceiptDirectory 'installed-lifecycle.json')
  } catch {
    $receiptFailure = $_
  }
  # The disposable runner also removes any native driver left by a failed probe.
}
if ($probeFailure) {
  if ($cleanupFailure) { Write-Warning 'Uninstall verification also failed; see installed-lifecycle.json. Preserving the original probe failure.' }
  if ($receiptFailure) { Write-Warning 'Lifecycle receipt could not be written. Preserving the original probe failure.' }
  throw $probeFailure
}
if ($cleanupFailure) {
  if ($receiptFailure) { Write-Warning 'Lifecycle receipt could not be written. Preserving the uninstall verification failure.' }
  throw $cleanupFailure
}
if ($receiptFailure) { throw $receiptFailure }
