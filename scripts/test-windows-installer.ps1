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
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$ReceiptDirectory = [IO.Path]::GetFullPath($ReceiptDirectory)
New-Item -ItemType Directory -Force -Path $ReceiptDirectory | Out-Null
$installRoot = Join-Path $env:RUNNER_TEMP ('RealBud installed probe ' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $installRoot 'RealBud.exe'
try {
  # NSIS requires /D last and consumes the remainder, including spaces.
  $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installRoot) -PassThru
  if (-not $setup.WaitForExit(120000)) { $setup.Kill(); throw 'Installer exceeded two minutes.' }
  if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
  if (-not (Test-Path -LiteralPath $app)) { throw 'Installer did not create the selected isolated destination.' }
  $env:ELECTRON_RUN_AS_NODE = '1'
  $script = Join-Path $PSScriptRoot 'smoke-windows-package.mjs'
  $resources = Join-Path $installRoot 'resources'
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
    throw 'Installed memory primitives exceeded two minutes.'
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
  # Load the installed compiled service using installed Electron/Node, with a
  # fresh home and no checkout node_modules or inherited provider credentials.
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
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_RESOURCES -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_EXECUTABLE -ErrorAction SilentlyContinue
  Remove-Item Env:QA_OUTPUT -ErrorAction SilentlyContinue
  $uninstaller = Join-Path $installRoot 'Uninstall RealBud.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
    if (-not $remove.WaitForExit(60000)) { $remove.Kill(); Write-Warning 'Probe uninstaller timed out.' }
  }
  # The disposable runner also removes any native driver left by a failed probe.
}
