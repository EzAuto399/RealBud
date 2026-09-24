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
if ($ExpectedInstallerSha256 -notmatch '^[0-9a-f]{64}$' -or $CompiledSourceSha -notmatch '^[0-9a-f]{40}$' -or $HarnessSourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Exact source and installer hashes are required.' }
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$qaFiles = @('scripts/qa-windows-restricted-startup.mjs', 'scripts/testing/test-windows-restricted-startup.ps1', 'scripts/testing/restricted-process-win.cs', 'scripts/service-smoke-env.mjs', 'scripts/smoke-one-shot-worker.mjs')
if ((& git -C $repo rev-parse HEAD).Trim() -ne $HarnessSourceSha) { throw 'Harness checkout does not match the requested source.' }
& git -C $repo ls-files --error-unmatch -- @qaFiles | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The reviewed QA files must be tracked.' }
& git -C $repo diff --quiet $HarnessSourceSha -- @qaFiles
if ($LASTEXITCODE -ne 0) { throw 'QA inputs differ from the reviewed source.' }
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'RealBud' }
if ($existing) { throw 'An existing RealBud installation must not be replaced.' }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$ArtifactReceipt = (Resolve-Path -LiteralPath $ArtifactReceipt).Path
$artifact = Get-Content -Raw -LiteralPath $ArtifactReceipt | ConvertFrom-Json
if ($artifact.schema -ne 1 -or $artifact.compiledSourceRevision -ne $CompiledSourceSha -or $artifact.installerSha256 -ne $ExpectedInstallerSha256 -or
    $artifact.expired -ne $false -or $artifact.artifactName -ne 'windows-installer' -or $artifact.runId -notmatch '^\d+$' -or $artifact.artifactId -notmatch '^\d+$') { throw 'Installer provenance refused.' }
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedInstallerSha256) { throw 'Installer hash mismatch; nothing was installed.' }
$ReceiptDirectory = [IO.Path]::GetFullPath($ReceiptDirectory)
if (Test-Path -LiteralPath $ReceiptDirectory) { throw 'Use a new receipt directory.' }
New-Item -ItemType Directory -Path $ReceiptDirectory | Out-Null
Copy-Item -LiteralPath $ArtifactReceipt -Destination (Join-Path $ReceiptDirectory 'artifact.json')
$inputHashes = @($qaFiles | ForEach-Object { [ordered]@{ file = $_; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo $_)).Hash.ToLowerInvariant() } })
$inputHashes | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $ReceiptDirectory 'qa-inputs.json')
$installRoot = Join-Path $env:RUNNER_TEMP ('RealBud startup proof ' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $installRoot 'RealBud.exe'
$resources = Join-Path $installRoot 'resources'
$probeDirectory = Join-Path $ReceiptDirectory 'probe'
$qaRoot = Join-Path $env:RUNNER_TEMP ('RealBud startup helper ' + [guid]::NewGuid().ToString('N'))
$qaLauncher = Join-Path $qaRoot 'RealBud QA Restricted.exe'
$qaSource = Join-Path $PSScriptRoot 'restricted-process-win.cs'
$qaFixture = [ordered]@{ sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaSource).Hash.ToLowerInvariant(); executableSha256 = $null; compiled = $false; removed = $false }
$installation = [ordered]@{ attempted = $false; exitCode = $null; appCreated = $false }
$uninstall = [ordered]@{ attempted = $false; exitCode = $null; appRemoved = $false; resourcesRemoved = $false; passed = $false }
$savedEnvironment = @{}
foreach ($name in @('ELECTRON_RUN_AS_NODE', 'REALBUD_QA_COMPILED_SHA', 'REALBUD_QA_HARNESS_SHA', 'REALBUD_QA_RESTRICTED_LAUNCHER', 'REALBUD_QA_RESTRICTED_LAUNCHER_SHA256', 'REALBUD_QA_RESTRICTED_SOURCE_SHA256')) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$probe = $null; $compilerProcess = $null; $diagnosticComplete = $false; $failure = $null; $cleanupFailure = $null; $stage = 'compile-helper'
try {
  New-Item -ItemType Directory -Path $qaRoot | Out-Null
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Compiler unavailable.' }
  $compilerArgs = '/nologo /optimize+ /target:exe /platform:x64 /out:"' + $qaLauncher + '" "' + $qaSource + '"'
  $compilerProcess = Start-Process -FilePath $compiler -ArgumentList $compilerArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'compile.stdout.log') -RedirectStandardError (Join-Path $ReceiptDirectory 'compile.stderr.log')
  if (-not $compilerProcess.WaitForExit(60000)) { $compilerProcess.Kill(); $compilerProcess.WaitForExit(5000) | Out-Null; throw 'Compilation deadline.' }
  if ($compilerProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $qaLauncher -PathType Leaf)) { throw 'Compilation failed.' }
  $qaFixture.compiled = $true
  $qaFixture.executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaLauncher).Hash.ToLowerInvariant()
  $stage = 'install'; $installation.attempted = $true
  $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installRoot) -PassThru
  if (-not $setup.WaitForExit(120000)) { $setup.Kill(); throw 'Install deadline.' }
  $installation.exitCode = $setup.ExitCode; $installation.appCreated = Test-Path -LiteralPath $app -PathType Leaf
  if ($setup.ExitCode -ne 0 -or -not $installation.appCreated) { throw 'Installation failed.' }
  $stage = 'startup-diagnostic'
  $env:ELECTRON_RUN_AS_NODE = '1'; $env:REALBUD_QA_COMPILED_SHA = $CompiledSourceSha; $env:REALBUD_QA_HARNESS_SHA = $HarnessSourceSha
  $env:REALBUD_QA_RESTRICTED_LAUNCHER = $qaLauncher; $env:REALBUD_QA_RESTRICTED_LAUNCHER_SHA256 = $qaFixture.executableSha256
  $env:REALBUD_QA_RESTRICTED_SOURCE_SHA256 = $qaFixture.sourceSha256
  $script = Join-Path $repo 'scripts/qa-windows-restricted-startup.mjs'
  $probe = Start-Process -FilePath $app -ArgumentList ('"' + $script + '" "' + $resources + '" "' + $probeDirectory + '"') -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $ReceiptDirectory 'probe.stdout.log') -RedirectStandardError (Join-Path $ReceiptDirectory 'probe.stderr.log')
  if (-not $probe.WaitForExit(180000)) { $probe.Kill(); $probe.WaitForExit(10000) | Out-Null; throw 'Diagnostic deadline.' }
  if ($probe.ExitCode -ne 0) { throw 'Diagnostic incomplete.' }
  $receipt = Get-Content -Raw -LiteralPath (Join-Path $probeDirectory 'receipt.json') | ConvertFrom-Json
  if ($receipt.schema -ne 1 -or $receipt.kind -ne 'restricted-startup-diagnostic' -or $receipt.diagnosticComplete -ne $true -or $receipt.officeAcceptance -ne $false -or
      $receipt.source.compiled -ne $CompiledSourceSha -or $receipt.source.harness -ne $HarnessSourceSha -or
      $receipt.source.helperSourceSha256 -ne $qaFixture.sourceSha256 -or $receipt.source.helperExecutableSha256 -ne $qaFixture.executableSha256 -or
      $receipt.lanes.Count -ne 3 -or $receipt.workerChecks.Count -ne 3 -or $receipt.cleanup.supervisorsClosed -ne $true -or
      $receipt.cleanup.observedPidsGone -ne $true -or $receipt.cleanup.scratchRemoved -ne $true) { throw 'Diagnostic receipt binding refused.' }
  $diagnosticComplete = $true
} catch { $failure = [ordered]@{ stage = $stage; code = 'diagnostic-incomplete' } }
finally {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
  try {
    if ($probe -and -not $probe.HasExited) { $probe.Kill(); if (-not $probe.WaitForExit(10000)) { throw 'Probe stop unconfirmed.' } }
    $stateFile = Join-Path $probeDirectory 'state.json'
    if (Test-Path -LiteralPath $stateFile) {
      $state = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
      if ($state.schema -ne 1 -or @($state.ownedPids | Where-Object { ($_ -isnot [long] -and $_ -isnot [int]) -or $_ -le 0 }).Count) { throw 'PID record refused.' }
      $end = [DateTime]::UtcNow.AddSeconds(15)
      do { $remaining = @($state.ownedPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }); if (-not $remaining.Count) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $end)
      if ($remaining.Count) { throw 'Owned process cleanup unconfirmed.' }
    } elseif ($probe) { throw 'Owned PID evidence missing.' }
  } catch { $cleanupFailure = 'owned-process-cleanup-unconfirmed' }
  try {
    $uninstaller = Join-Path $installRoot 'Uninstall RealBud.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      $uninstall.attempted = $true; $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
      if (-not $remove.WaitForExit(60000)) { $remove.Kill(); throw 'Uninstall deadline.' }
      $uninstall.exitCode = $remove.ExitCode; $end = [DateTime]::UtcNow.AddSeconds(60)
      do {
        $uninstall.appRemoved = -not (Test-Path -LiteralPath $app); $uninstall.resourcesRemoved = -not (Test-Path -LiteralPath $resources)
        if ($uninstall.appRemoved -and $uninstall.resourcesRemoved) { break }; Start-Sleep -Milliseconds 250
      } while ([DateTime]::UtcNow -lt $end)
      if ($remove.ExitCode -ne 0 -or -not $uninstall.appRemoved -or -not $uninstall.resourcesRemoved) { throw 'Uninstall unconfirmed.' }
    } else {
      $uninstall.appRemoved = -not (Test-Path -LiteralPath $app); $uninstall.resourcesRemoved = -not (Test-Path -LiteralPath $resources)
      if ($installation.appCreated -or -not $uninstall.appRemoved -or -not $uninstall.resourcesRemoved) { throw 'Uninstaller missing.' }
    }
    $uninstall.passed = $true
  } catch { $cleanupFailure = 'uninstall-unconfirmed' }
  try {
    if ($compilerProcess -and -not $compilerProcess.HasExited) { $compilerProcess.Kill(); $compilerProcess.WaitForExit(5000) | Out-Null }
    if (-not $cleanupFailure -and (Test-Path -LiteralPath $qaRoot)) { Remove-Item -LiteralPath $qaRoot -Recurse -Force }
    $qaFixture.removed = -not (Test-Path -LiteralPath $qaRoot)
    if (-not $qaFixture.removed) { throw 'Helper cleanup unconfirmed.' }
  } catch { $cleanupFailure = 'helper-cleanup-unconfirmed' }
  $linked = @()
  foreach ($name in @('artifact.json', 'qa-inputs.json', 'probe/receipt.json', 'probe/state.json')) {
    $file = Join-Path $ReceiptDirectory $name
    if (Test-Path -LiteralPath $file -PathType Leaf) { $linked += [ordered]@{ file = $name; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() } }
  }
  [ordered]@{ schema = 1; kind = 'installed-restricted-startup-diagnostic'; diagnosticComplete = $diagnosticComplete -and $uninstall.passed -and -not $cleanupFailure; officeAcceptance = $false
    compiledSourceRevision = $CompiledSourceSha; harnessSourceRevision = $HarnessSourceSha
    installer = [ordered]@{ sha256 = $actualHash; bytes = (Get-Item -LiteralPath $Installer).Length }
    installation = $installation; uninstall = $uninstall; qaFixture = $qaFixture; failure = $failure; cleanupFailure = $cleanupFailure; receipts = $linked
    limits = @('A completed diagnostic is not office acceptance.', 'Same-SID restricted fixture, not a normal Windows11 user session.', 'No accounts, GUI, PostgreSQL or provider calls.')
  } | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $ReceiptDirectory 'lifecycle.json')
}
if (-not $diagnosticComplete -or -not $uninstall.passed -or $cleanupFailure) { throw 'Startup diagnostic or cleanup incomplete; inspect fixed receipts.' }
Write-Output 'Startup diagnostic recorded; office acceptance remains unproved.'
