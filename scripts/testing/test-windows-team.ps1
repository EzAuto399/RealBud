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
$qaRoot = Join-Path $env:RUNNER_TEMP ('RealBud restricted QA ' + [guid]::NewGuid().ToString('N'))
$qaLauncher = Join-Path $qaRoot 'RealBud QA Restricted.exe'
$qaSource = Join-Path $PSScriptRoot 'restricted-process-win.cs'
$qaCompiler = $null
$qaFixture = [ordered]@{ kind = 'same-user-restricted-token'; sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaSource).Hash.ToLowerInvariant(); executableSha256 = $null; compiled = $false; removed = $false }
$installation = [ordered]@{ attempted = $false; exitCode = $null; appCreated = $false }
$uninstall = [ordered]@{ attempted = $false; exitCode = $null; appRemoved = $false; resourcesRemoved = $false; passed = $false }
$probe = $null; $probePassed = $false; $failure = $null; $cleanupFailure = $null; $stage = 'install'
try {
  $stage = 'compile-qa-launcher'
  New-Item -ItemType Directory -Path $qaRoot | Out-Null
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Framework4 compiler for QA token launcher is unavailable.' }
  $compilerArgs = '/nologo /optimize+ /target:exe /platform:x64 /out:"' + $qaLauncher + '" "' + $qaSource + '"'
  $qaCompiler = Start-Process -FilePath $compiler -ArgumentList $compilerArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'qa-compile.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'qa-compile.stderr.log')
  if (-not $qaCompiler.WaitForExit(60000)) { $qaCompiler.Kill(); $qaCompiler.WaitForExit(5000) | Out-Null; throw 'QA token launcher compilation exceeded one minute.' }
  if ($qaCompiler.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $qaLauncher -PathType Leaf)) { throw 'QA token launcher compilation failed.' }
  $qaFixture.compiled = $true
  $qaFixture.executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaLauncher).Hash.ToLowerInvariant()
  $stage = 'install'
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
  $env:REALBUD_QA_RESTRICTED_LAUNCHER = $qaLauncher
  $env:REALBUD_QA_RESTRICTED_LAUNCHER_SHA256 = $qaFixture.executableSha256
  $env:REALBUD_QA_RESTRICTED_SOURCE_SHA256 = $qaFixture.sourceSha256
  $script = Join-Path (Split-Path -Parent $PSScriptRoot) 'qa-windows-team.mjs'
  $arguments = '"' + $script + '" "' + $resources + '" "' + $teamDirectory + '"'
  $probe = Start-Process -FilePath $app -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'probe.stdout.log') `
    -RedirectStandardError (Join-Path $ReceiptDirectory 'probe.stderr.log')
  if (-not $probe.WaitForExit(720000)) {
    # The outer Node process owns the tested liveness pipe. Killing this handle
    # closes the native supervisor's Job; do not depend on a leader-PID tree walk.
    $probe.Kill(); $probe.WaitForExit(10000) | Out-Null
    throw 'Installed team proof exceeded twelve minutes.'
  }
  if ($probe.ExitCode -ne 0) { throw 'Installed team proof failed.' }
  $receipt = Get-Content -Raw -LiteralPath (Join-Path $teamDirectory 'receipt.json') | ConvertFrom-Json
  if (-not $receipt.passed -or -not $receipt.cleanupComplete -or $receipt.platform -ne 'win32' -or
      -not $receipt.runtime.electron -or $receipt.compiledSourceRevision -ne $CompiledSourceSha -or
      $receipt.harnessSourceRevision -ne $HarnessSourceSha -or
      $receipt.qaLaunch.mode -ne 'same-user-restricted-token' -or $receipt.qaLaunch.sourceSha256 -ne $qaFixture.sourceSha256 -or
      $receipt.qaLaunch.executableSha256 -ne $qaFixture.executableSha256 -or $receipt.restrictedChecks.Count -ne 5 -or
      -not $receipt.elevatedPreflight.passed -or -not $receipt.elevatedPreflight.cleanupComplete -or $receipt.elevatedPreflight.checks.Count -ne 2 -or
      [IO.Path]::GetFullPath($receipt.resources) -ne [IO.Path]::GetFullPath($resources) -or
      [IO.Path]::GetFullPath($receipt.executable) -ne [IO.Path]::GetFullPath($app)) { throw 'Installed team receipt binding failed.' }
  $scenario = Get-Content -Raw -LiteralPath (Join-Path $teamDirectory 'scenario.json') | ConvertFrom-Json
  if (-not $scenario.passed -or $scenario.checks.Count -ne 7 -or -not $scenario.cleanupComplete) { throw 'Seven scenario groups did not pass.' }
  $launchProofs = @($receipt.restrictedLaunches)
  $launchNames = @($launchProofs | ForEach-Object { $_.control } | Sort-Object)
  if ($launchProofs.Count -ne 5 -or ($launchNames -join ',') -ne 'argv-exit,normal,office-scenario,parent-death,timeout' -or @($launchProofs | Where-Object {
      $_.sameUser -ne $true -or $_.jobInherited -ne $true -or $_.administratorEnabled -ne $false -or $_.powerUsersEnabled -ne $false -or
      $_.parentDefaultOwnerIsUser -isnot [bool] -or $_.restrictedDefaultOwnerWasUser -isnot [bool] -or
      $_.restrictedDefaultOwnerIsUser -ne $true -or $_.tokenDefaultOwnerIsUser -ne $true
    }).Count) { throw 'Restricted launcher owner/authority proof is incomplete.' }
  $officeLaunch = @($launchProofs | Where-Object { $_.control -eq 'office-scenario' })[0]
  $fixtureOwners = @($scenario.fixtureOwnership)
  $ownerKeys = @($fixtureOwners | ForEach-Object { $_.role + '/' + $_.label } | Sort-Object)
  if ($fixtureOwners.Count -ne 6 -or ($ownerKeys -join ',') -ne 'client/config,client/private-root,client/service-admin,host/config,host/private-root,host/service-admin' -or
      @($fixtureOwners | Where-Object { $_.outcome -ne 'queried' -or $_.pid -ne $officeLaunch.childPid -or $_.sameUser -ne $true -or $_.administratorEnabled -ne $false -or $_.powerUsersEnabled -ne $false -or $_.tokenDefaultOwnerIsUser -ne $true -or $_.objectOwnerIsUser -ne $true }).Count) {
    throw 'Actual fresh fixture object ownership was not proved.'
  }
  $serviceTokens = @($scenario.nativeDiagnostics | Where-Object { $_.operation -eq 'service-token' })
  if ($serviceTokens.Count -ne 5 -or @($serviceTokens | Where-Object { $_.role -eq 'host' }).Count -ne 3 -or @($serviceTokens | Where-Object { $_.role -eq 'client' }).Count -ne 2 -or
      @($serviceTokens | Where-Object { $_.outcome -ne 'queried' -or $_.pid -ne $_.servicePid -or $_.sameUser -ne $true -or $_.administratorEnabled -ne $false -or $_.powerUsersEnabled -ne $false -or $_.tokenDefaultOwnerIsUser -ne $true }).Count) {
    throw 'Actual restarted service token ownership was not proved.'
  }
  $elevated = Get-Content -Raw -LiteralPath (Join-Path $teamDirectory 'elevated/scenario.json') | ConvertFrom-Json
  if (-not $elevated.passed -or $elevated.mode -ne 'elevated-preflight' -or $elevated.checks.Count -ne 2 -or -not $elevated.cleanupComplete) { throw 'Elevated no-write acceptance did not pass.' }
  $probePassed = $true
} catch { $failure = [string]$_.Exception.Message }
finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_COMPILED_SHA -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_HARNESS_SHA -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_RESTRICTED_LAUNCHER -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_RESTRICTED_LAUNCHER_SHA256 -ErrorAction SilentlyContinue
  Remove-Item Env:REALBUD_QA_RESTRICTED_SOURCE_SHA256 -ErrorAction SilentlyContinue
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
    $elevatedController = Join-Path $teamDirectory 'elevated/controller.json'
    $elevatedState = Join-Path $teamDirectory 'elevated/scenario-state.json'
    if (Test-Path -LiteralPath $elevatedController) { $ownedPids += (Get-Content -Raw -LiteralPath $elevatedController | ConvertFrom-Json).supervisorPid }
    if (Test-Path -LiteralPath $elevatedState) { $ownedPids += (Get-Content -Raw -LiteralPath $elevatedState | ConvertFrom-Json).observedPids }
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
  try {
    if ($qaCompiler -and -not $qaCompiler.HasExited) { $qaCompiler.Kill(); $qaCompiler.WaitForExit(5000) | Out-Null }
    # The probe's Job must be gone before its auxiliary test executable is removed.
    if (-not $cleanupFailure -and (Test-Path -LiteralPath $qaRoot)) { Remove-Item -LiteralPath $qaRoot -Recurse -Force }
    $qaFixture.removed = -not (Test-Path -LiteralPath $qaRoot)
    if (-not $qaFixture.removed) { throw 'QA launcher cleanup could not be confirmed.' }
  } catch { $cleanupFailure = [string]$_.Exception.Message }
  $linked = @()
  foreach ($name in @('artifact.json', 'team/receipt.json', 'team/scenario.json', 'team/scenario-state.json', 'team/controller.json', 'team/elevated/scenario.json', 'team/elevated/scenario-state.json', 'team/elevated/controller.json')) {
    $file = Join-Path $ReceiptDirectory $name
    if (Test-Path -LiteralPath $file -PathType Leaf) { $linked += [ordered]@{ file = $name; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() } }
  }
  [ordered]@{ schema = 1; kind = 'realbud-installed-windows-team'; generatedAt = [DateTime]::UtcNow.ToString('o')
    passed = $probePassed -and $uninstall.passed -and -not $cleanupFailure; compiledSourceRevision = $CompiledSourceSha; harnessSourceRevision = $HarnessSourceSha
    installer = [ordered]@{ file = [IO.Path]::GetFileName($Installer); sha256 = $actualHash; bytes = (Get-Item -LiteralPath $Installer).Length }
    installation = $installation; uninstall = $uninstall; qaFixture = $qaFixture; stage = $stage; failure = $failure; cleanupFailure = $cleanupFailure; receipts = $linked
    limits = @('Same-SID restricted-token fixture; not a standard-user Windows11/UAC launch.', 'One disposable Windows CI machine; not two physical Windows11 devices.', 'No live account, rendered UI, model or Hermes provisioning.', 'Uninstall proves application/resource removal, not user-data preservation.')
  } | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $ReceiptDirectory 'lifecycle.json')
}
if ($failure) { throw $failure }
if ($cleanupFailure) { throw $cleanupFailure }
if (-not $probePassed -or -not $uninstall.passed) { throw 'Installed team acceptance did not complete.' }
Write-Output ('PASSED installed two-service Windows proof: ' + $ReceiptDirectory)
