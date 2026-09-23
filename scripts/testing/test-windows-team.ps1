param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ArtifactReceipt,
  [Parameter(Mandatory=$true)][string]$ReceiptDirectory,
  [Parameter(Mandatory=$true)][string]$ExpectedInstallerSha256,
  [Parameter(Mandatory=$true)][string]$CompiledSourceSha,
  [Parameter(Mandatory=$true)][string]$HarnessSourceSha
)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or -not $IsWindows -or -not $env:RUNNER_TEMP) { throw 'Use a disposable Windows CI runner.' }
if ($ExpectedInstallerSha256 -notmatch '^[0-9a-f]{64}$' -or $CompiledSourceSha -notmatch '^[0-9a-f]{40}$' -or $HarnessSourceSha -notmatch '^[0-9a-f]{40}$') {
  throw 'Exact installer SHA256 and full compiled/harness source SHAs are required.'
}
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'RealBud' }
if ($existing) { throw 'An existing RealBud installation must not be replaced.' }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$ArtifactReceipt = (Resolve-Path -LiteralPath $ArtifactReceipt).Path
$artifact = Get-Content -Raw -LiteralPath $ArtifactReceipt | ConvertFrom-Json
if ($artifact.schema -ne 1 -or $artifact.compiledSourceRevision -ne $CompiledSourceSha -or
    $artifact.installerSha256 -ne $ExpectedInstallerSha256 -or $artifact.expired -ne $false -or
    $artifact.artifactName -ne 'windows-installer' -or $artifact.runId -notmatch '^\d+$' -or $artifact.artifactId -notmatch '^\d+$') {
  throw 'Artifact provenance does not match the requested installer.'
}
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedInstallerSha256) { throw 'Installer hash mismatch; nothing was installed.' }
$ReceiptDirectory = [IO.Path]::GetFullPath($ReceiptDirectory)
if (Test-Path -LiteralPath $ReceiptDirectory) { throw 'Use a new receipt directory.' }
New-Item -ItemType Directory -Path $ReceiptDirectory | Out-Null
Copy-Item -LiteralPath $ArtifactReceipt -Destination (Join-Path $ReceiptDirectory 'artifact.json')
$installRoot = Join-Path $env:RUNNER_TEMP ('RealBud team proof ' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $installRoot 'RealBud.exe'
$resources = Join-Path $installRoot 'resources'
$teamDirectory = Join-Path $ReceiptDirectory 'team'
$installation = [ordered]@{ attempted = $false; exitCode = $null; appCreated = $false }
$uninstall = [ordered]@{ attempted = $false; exitCode = $null; appRemoved = $false; resourcesRemoved = $false; passed = $false }
$probe = $null; $probePassed = $false; $failure = $null; $cleanupFailure = $null; $stage = 'install'
try {
  $installation.attempted = $true
  # NSIS requires /D last; it consumes the remainder, including spaces.
  $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installRoot) -PassThru
  if (-not $setup.WaitForExit(120000)) { $setup.Kill(); throw 'Installer exceeded two minutes.' }
  $installation.exitCode = $setup.ExitCode
  $installation.appCreated = Test-Path -LiteralPath $app -PathType Leaf
  if ($setup.ExitCode -ne 0 -or -not $installation.appCreated) { throw 'Installer did not complete.' }
  $stage = 'installed-two-service-proof'
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:REALBUD_QA_COMPILED_SHA = $CompiledSourceSha
  $env:REALBUD_QA_HARNESS_SHA = $HarnessSourceSha
  $script = Join-Path (Split-Path -Parent $PSScriptRoot) 'qa-windows-team.mjs'
  $arguments = '"' + $script + '" "' + $resources + '" "' + $teamDirectory + '"'
  $probe = Start-Process -FilePath $app -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'probe.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'probe.stderr.log')
  if (-not $probe.WaitForExit(600000)) {
    # The outer Node process owns the tested liveness pipe. Killing this handle
    # closes the native supervisor's Job; do not depend on a leader-PID tree walk.
    $probe.Kill(); $probe.WaitForExit(10000) | Out-Null
    throw 'Installed team proof exceeded ten minutes.'
  }
  if ($probe.ExitCode -ne 0) { throw 'Installed team proof failed.' }
  $receipt = Get-Content -Raw -LiteralPath (Join-Path $teamDirectory 'receipt.json') | ConvertFrom-Json
  if (-not $receipt.passed -or -not $receipt.cleanupComplete -or $receipt.platform -ne 'win32' -or
      -not $receipt.runtime.electron -or $receipt.compiledSourceRevision -ne $CompiledSourceSha -or
      $receipt.harnessSourceRevision -ne $HarnessSourceSha -or
      [IO.Path]::GetFullPath($receipt.resources) -ne [IO.Path]::GetFullPath($resources) -or
      [IO.Path]::GetFullPath($receipt.executable) -ne [IO.Path]::GetFullPath($app)) { throw 'Installed team receipt binding failed.' }
  $scenario = Get-Content -Raw -LiteralPath (Join-Path $teamDirectory 'scenario.json') | ConvertFrom-Json
  if (-not $scenario.passed -or $scenario.checks.Count -ne 7 -or -not $scenario.cleanupComplete) { throw 'Seven scenario groups did not pass.' }
  $probePassed = $true
} catch { $failure = [string]$_.Exception.Message }
finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_COMPILED_SHA -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_HARNESS_SHA -ErrorAction SilentlyContinue
  try {
    if ($probe -and -not $probe.HasExited) { $probe.Kill(); $probe.WaitForExit(10000) | Out-Null }
  } catch { $cleanupFailure = 'The owned probe stop could not be confirmed.' }
  try {
    # Only PIDs written by this unique disposable run are inspected. The API
    # child remains in its native Job even if this PowerShell deadline fires.
    $ownedPids = @()
    $controllerPath = Join-Path $teamDirectory 'controller.json'
    $statePath = Join-Path $teamDirectory 'scenario-state.json'
    if (Test-Path -LiteralPath $controllerPath) { $ownedPids += (Get-Content -Raw -LiteralPath $controllerPath | ConvertFrom-Json).supervisorPid }
    if (Test-Path -LiteralPath $statePath) { $ownedPids += (Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json).observedPids }
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $remaining = @($ownedPids | Where-Object { $_ -is [long] -or $_ -is [int] } | Where-Object { $_ -gt 0 } |
        Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
      if ($remaining.Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)
    if ($remaining.Count -ne 0) { throw 'Owned native team processes remain after the cleanup deadline.' }
  } catch { $cleanupFailure = [string]$_.Exception.Message }
  try {
    $uninstaller = Join-Path $installRoot 'Uninstall RealBud.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      $uninstall.attempted = $true
      $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
      if (-not $remove.WaitForExit(60000)) { $remove.Kill(); throw 'Uninstaller launcher exceeded one minute.' }
      $uninstall.exitCode = $remove.ExitCode
      $end = [DateTime]::UtcNow.AddSeconds(60)
      do {
        $uninstall.appRemoved = -not (Test-Path -LiteralPath $app)
        $uninstall.resourcesRemoved = -not (Test-Path -LiteralPath $resources)
        if ($uninstall.appRemoved -and $uninstall.resourcesRemoved) { break }
        Start-Sleep -Milliseconds 250
      } while ([DateTime]::UtcNow -lt $end)
      if ($remove.ExitCode -ne 0 -or -not $uninstall.appRemoved -or -not $uninstall.resourcesRemoved) { throw 'Disposable uninstall was not confirmed.' }
    } else {
      $uninstall.appRemoved = -not (Test-Path -LiteralPath $app)
      $uninstall.resourcesRemoved = -not (Test-Path -LiteralPath $resources)
      if ($installation.appCreated -or -not $uninstall.appRemoved -or -not $uninstall.resourcesRemoved) { throw 'Disposable uninstaller is missing.' }
    }
    $uninstall.passed = $true
  } catch { $cleanupFailure = [string]$_.Exception.Message }
  $linked = @()
  foreach ($name in @('artifact.json', 'team/receipt.json', 'team/scenario.json', 'team/scenario-state.json', 'team/controller.json')) {
    $file = Join-Path $ReceiptDirectory $name
    if (Test-Path -LiteralPath $file -PathType Leaf) { $linked += [ordered]@{ file = $name; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() } }
  }
  [ordered]@{ schema = 1; kind = 'realbud-installed-windows-team'; generatedAt = [DateTime]::UtcNow.ToString('o')
    passed = $probePassed -and $uninstall.passed -and -not $cleanupFailure; compiledSourceRevision = $CompiledSourceSha; harnessSourceRevision = $HarnessSourceSha
    installer = [ordered]@{ file = [IO.Path]::GetFileName($Installer); sha256 = $actualHash; bytes = (Get-Item -LiteralPath $Installer).Length }
    installation = $installation; uninstall = $uninstall; stage = $stage; failure = $failure; cleanupFailure = $cleanupFailure; receipts = $linked
    limits = @('One disposable Windows CI machine; not two physical Windows11 devices.', 'No live account, rendered UI, model or Hermes provisioning.', 'Uninstall proves application/resource removal, not user-data preservation.')
  } | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $ReceiptDirectory 'lifecycle.json')
}
if ($failure) { throw $failure }
if ($cleanupFailure) { throw $cleanupFailure }
if (-not $probePassed -or -not $uninstall.passed) { throw 'Installed team acceptance did not complete.' }
Write-Output ('PASSED installed two-service Windows proof: ' + $ReceiptDirectory)
