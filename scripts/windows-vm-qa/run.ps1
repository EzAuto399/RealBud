# RealBud Windows clean-environment QA, VM side. launch.sh uploads this file as
# the windows-startup-script-ps1 metadata, sets rbqa-run / rbqa-ref and resets
# the VM. It runs as SYSTEM (Windows PowerShell 5.1) on every boot and acts only
# for a run id it has not seen. Fictional data only: no customer account, REI,
# Modelvia key or Windows password is used or created.
#
# Serial-port contract read by launch.sh:
#   RBQA-START <run> ...            first line of a run
#   RBQA-RESULT {json}              one per step: run, step, status, counts, detail
#   RBQA-LOG <step> | <line>        tail of a failing step's log
#   RBQA-DONE <run>                 last line
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Pinned tools, checksums from nodejs.org SHASUMS256.txt and the git-for-windows
# release asset digest. Git for Windows ships no MSI; MinGit is its official zip.
$NodeVersion = '24.21.0'
$NodeMsiSha256 = 'bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac'
$MinGitVersion = '2.56.0.2'
$MinGitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip'
$MinGitSha256 = 'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be'
$Repo = 'https://github.com/EzAuto399/RealBud.git'

function Meta($key) {
  try { return [string](Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Headers @{ 'Metadata-Flavor' = 'Google' } -Uri "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$key") } catch { return '' }
}
$Run = Meta 'rbqa-run'
$Ref = Meta 'rbqa-ref'
$Steps = Meta 'rbqa-steps'; if (-not $Steps) { $Steps = 'all' }
$Bucket = Meta 'rbqa-bucket'
$InstallerName = Meta 'rbqa-installer'
if ($Run -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $Ref -notmatch '^[A-Za-z0-9._/-]{1,200}$') { Write-Host 'RBQA idle: no valid rbqa-run / rbqa-ref metadata'; exit 0 }
$Q = 'C:\q'
$Work = Join-Path $Q $Run
$RunLog = Join-Path $Work 'rbqa.log'

# Launcher (the startup script itself): run the steps in a separate worker
# PowerShell and copy its log to the serial port, so a worker that dies is
# reported by exit code instead of silence. The GCE runner drops a script's
# last lines when the script exits, so the launcher pauses before it does.
if ($env:RBQA_WORKER -ne '1') {
  if (Test-Path -LiteralPath $Work) { Write-Host "RBQA run $Run already started on an earlier boot; not repeating it"; Write-Host "RBQA-DONE $Run"; exit 0 }
  $vmUsedBefore = Test-Path -LiteralPath (Join-Path $Q 'vm-used')
  New-Item -ItemType Directory -Force -Path $Work, (Join-Path $Work 'logs'), (Join-Path $Q 'cache'), (Join-Path $Q 'tools') | Out-Null
  Set-Content -LiteralPath (Join-Path $Q 'vm-used') -Value $Run
  $self = Join-Path $Work 'run.ps1'
  $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers @{ 'Metadata-Flavor' = 'Google' } -Uri 'http://metadata.google.internal/computeMetadata/v1/instance/attributes/windows-startup-script-ps1'
  [IO.File]::WriteAllBytes($self, $resp.RawContentStream.ToArray())
  $psi = New-Object Diagnostics.ProcessStartInfo "$PSHOME\powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$self`""
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['RBQA_WORKER'] = '1'; $psi.EnvironmentVariables['RBQA_VM_USED_BEFORE'] = [string]$vmUsedBefore
  $worker = [Diagnostics.Process]::Start($psi)
  Write-Host "RBQA-START $Run ref=$Ref steps=$Steps worker=$($worker.Id)"
  $pos = 0; $done = $false
  while ($true) {
    $exited = $worker.WaitForExit(5000)
    if (Test-Path -LiteralPath $RunLog) {
      $fs = [IO.File]::Open($RunLog, 'Open', 'Read', 'ReadWrite')
      $null = $fs.Seek($pos, 'Begin')
      $reader = New-Object IO.StreamReader($fs, [Text.Encoding]::ASCII)
      while ($null -ne ($line = $reader.ReadLine())) { Write-Host $line; if ($line -eq "RBQA-DONE $Run") { $done = $true } }
      $pos = $fs.Position; $reader.Close()
    }
    if ($exited) { break }
  }
  if (-not $done) { Write-Host "RBQA-TRAP worker pid $($worker.Id) exited with code $($worker.ExitCode) before RBQA-DONE"; Write-Host "RBQA-DONE $Run" }
  Start-Sleep -Seconds 15
  exit 0
}

# Worker from here on: every line goes to the run log, which the launcher copies out.
function Say($line) { [IO.File]::AppendAllText($RunLog, ([string]$line -replace '[^\x20-\x7E]', '?') + "`r`n", [Text.Encoding]::ASCII) }
$vmUsedBefore = $env:RBQA_VM_USED_BEFORE -eq 'True'
$Logs = Join-Path $Work 'logs'
$Src = Join-Path $Work 'src'
$Out = Join-Path $Work 'out'
$runStart = Get-Date

# Any terminating error is reported with its line and the run carries on, so a
# harness slip can never end the script silently between steps.
trap { Say "RBQA-TRAP line $($_.InvocationInfo.ScriptLineNumber) $($_.Exception.GetType().FullName): $($_.Exception.Message)"; continue }
function Want($name) { return $Steps -eq 'all' -or (($Steps -split ',') -contains $name) }
# ASCII only: a non-ASCII byte on the serial port has cut the runner's capture short.
function Clip($text, $max = 400) { $t = [string]$text -replace '[^\x20-\x7E]', '?'; if ($t.Length -gt $max) { return $t.Substring(0, $max) + '...' } return $t }
function Result($step, $status, $data) {
  $o = [ordered]@{ run = $Run; step = $step; status = $status }
  if ($data) { foreach ($k in $data.Keys) { $o[$k] = $data[$k] } }
  Say ('RBQA-RESULT ' + ((ConvertTo-Json -InputObject $o -Compress -Depth 6) -replace '[^\x20-\x7E]', '?'))
}
function Tail($step, $path, $n = 60) {
  if ($path -and (Test-Path -LiteralPath $path)) { Get-Content -LiteralPath $path -Tail $n | ForEach-Object { Say "RBQA-LOG $step | $(Clip $_ 300)" } }
}
function Since($t) { return [int]((Get-Date) - $t).TotalSeconds }
# One command line through cmd.exe with stdout+stderr in a log file and a hard
# deadline; a timeout kills the whole process tree. Never through PowerShell's
# native-stderr handling, which turns warnings into terminating errors.
function Exec($name, $cmdline, $timeoutMin, $cwd = $Src) {
  $log = Join-Path $Logs "$name.log"
  # Own hidden console and stdin from NUL: nothing waits on the runner's pipes.
  $psi = New-Object Diagnostics.ProcessStartInfo "$env:SystemRoot\System32\cmd.exe", "/d /c $cmdline < NUL > `"$log`" 2>&1"
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $cwd
  $p = [Diagnostics.Process]::Start($psi)
  Say "RBQA-BEAT $name started pid=$($p.Id)"
  $t = Get-Date
  # A heartbeat a minute, so a slow or stuck step is visible on the serial port.
  while (-not $p.WaitForExit(60000)) {
    Say "RBQA-BEAT $name $(Since $t)s log=$((Get-Item -LiteralPath $log -ErrorAction SilentlyContinue).Length)B"
    if ((Since $t) -ge $timeoutMin * 60) {
      Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList "/T /F /PID $($p.Id)" -NoNewWindow -Wait
      return @{ code = 124; log = $log; timedOut = $true }
    }
  }
  return @{ code = $p.ExitCode; log = $log; timedOut = $false }
}
function Fetch($url, $file, $sha256) {
  if (-not (Test-Path -LiteralPath $file)) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($actual -ne $sha256) { Remove-Item -Force -LiteralPath $file; throw "checksum mismatch for $url ($actual)" }
}

# -- setup: Node 24 (MSI), MinGit, pnpm via corepack, Edge ------------------
$setupOk = $false
try {
  $t = Get-Date
  $os = Get-CimInstance Win32_OperatingSystem
  $nodeExe = "$env:ProgramFiles\nodejs\node.exe"
  $nodePre = (Test-Path -LiteralPath $nodeExe) -and ((& $nodeExe -v) -eq "v$NodeVersion")
  if (-not $nodePre) {
    $msi = Join-Path $Q "cache\node-v$NodeVersion-x64.msi"
    Fetch "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi" $msi $NodeMsiSha256
    $p = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "node MSI exit $($p.ExitCode)" }
  }
  $gitDir = Join-Path $Q "tools\mingit-$MinGitVersion"
  $gitPre = Test-Path -LiteralPath "$gitDir\cmd\git.exe"
  if (-not $gitPre) {
    $zip = Join-Path $Q "cache\MinGit-$MinGitVersion-64-bit.zip"
    Fetch $MinGitUrl $zip $MinGitSha256
    Expand-Archive -LiteralPath $zip -DestinationPath $gitDir -Force
  }
  $env:Path = "$env:ProgramFiles\nodejs;$gitDir\cmd;$env:Path"
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  $env:CI = 'true'
  $r = Exec 'corepack' 'corepack enable' 5 $Q
  if ($r.code -ne 0) { Tail 'setup' $r.log; throw "corepack enable exit $($r.code)" }
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($edge) { $env:CHROME_EXECUTABLE = $edge }
  Result 'setup' 'PASS' ([ordered]@{
    os = "$($os.Caption) $($os.Version)"; user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    node = (& $nodeExe -v); nodePreinstalled = $nodePre; git = $MinGitVersion; gitPreinstalled = $gitPre
    edge = [string]$edge; vmUsedBefore = $vmUsedBefore; seconds = (Since $t) })
  $setupOk = $true
} catch { Result 'setup' 'ERROR' @{ error = (Clip $_.Exception.Message) } }

# -- (a) installer smoke: the CI-built installer from the private bucket ---
function Get-RealBudProcesses {
  @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'RealBud*' -or $_.Name -eq 'Au_.exe' -or ($_.ExecutablePath -and ($_.ExecutablePath -like '*\Programs\realbud\*' -or $_.ExecutablePath -like '*\~nsu*')) })
}
function Health {
  foreach ($port in 8799, 18799, 28799) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/api/health"
      if ($resp.StatusCode -eq 200) { $b = $resp.Content | ConvertFrom-Json; return @{ port = $port; pid = $b.pid; app = $b.app } }
    } catch { }
  }
  return $null
}
if ($setupOk -and (Want 'smoke')) {
  $t = Get-Date
  $d = [ordered]@{}
  $fail = @()
  try {
    if (-not $Bucket -or -not $InstallerName) { throw 'rbqa-bucket / rbqa-installer metadata missing' }
    # Clean slate: this VM's SYSTEM profile only (the 32-bit installer writes under SysWOW64).
    $profiles = @("$env:SystemRoot\System32\config\systemprofile", "$env:SystemRoot\SysWOW64\config\systemprofile")
    foreach ($pr in $profiles) {
      $un = Join-Path $pr 'AppData\Local\Programs\realbud\Uninstall RealBud.exe'
      if (Test-Path -LiteralPath $un) { Start-Process -FilePath $un -ArgumentList '/S' -Wait | Out-Null; Start-Sleep -Seconds 20; $d.previousInstallRemoved = $true }
    }
    Get-RealBudProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($pr in $profiles) { foreach ($sub in '.realbud', 'AppData\Roaming\RealBud', 'AppData\Local\Programs\realbud') { Remove-Item -Recurse -Force -LiteralPath (Join-Path $pr $sub) -ErrorAction SilentlyContinue } }

    $setup = Join-Path $Work $InstallerName
    $token = (Invoke-RestMethod -UseBasicParsing -Headers @{ 'Metadata-Flavor' = 'Google' } -Uri 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token').access_token
    Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = "Bearer $token" } -Uri "https://storage.googleapis.com/storage/v1/b/$Bucket/o/$([uri]::EscapeDataString($InstallerName))?alt=media" -OutFile $setup
    $token = $null
    $d.installer = $InstallerName
    $d.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant()
    $d.signature = [string](Get-AuthenticodeSignature -LiteralPath $setup).Status

    $ti = Get-Date
    $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
    $null = $p.Handle
    if (-not $p.WaitForExit(300000)) { throw 'installer exceeded 5 minutes' }
    $d.installExit = $p.ExitCode; $d.installSeconds = Since $ti
    if ($p.ExitCode -ne 0) { $fail += "installer exit $($p.ExitCode)" }
    $exe = $profiles | ForEach-Object { Join-Path $_ 'AppData\Local\Programs\realbud\RealBud.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $exe) { throw 'installed RealBud.exe not found under either SYSTEM profile' }
    $instDir = Split-Path -Parent $exe
    $d.installedExe = $exe; $d.version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion

    Start-Sleep -Seconds 5
    if (-not (Get-RealBudProcesses)) { Start-Process -FilePath $exe | Out-Null; $d.launchedBy = 'harness' } else { $d.launchedBy = 'installer' }
    $tl = Get-Date; $h = $null
    while (-not $h -and (Since $tl) -lt 180) { $h = Health; if (-not $h) { Start-Sleep -Seconds 2 } }
    if ($h) { $d.healthSeconds = Since $tl; $d.healthPort = $h.port; $d.healthApp = $h.app } else { $fail += 'no /api/health 200 within 180 s' }
    $d.processesRunning = @(Get-RealBudProcesses).Count

    $sf = Join-Path $env:USERPROFILE '.realbud\local-auth\session.json'
    $d.sessionFile = $sf
    if (Test-Path -LiteralPath $sf) {
      $rec = Get-Content -Raw -LiteralPath $sf | ConvertFrom-Json
      $d.sessionMatchesHealth = [bool]($h -and $rec.pid -eq $h.pid -and $rec.port -eq $h.port)
      if (-not $d.sessionMatchesHealth) { $fail += 'session record does not name the healthy service' }
      $acl = Get-Acl -LiteralPath $sf
      $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $allowed = @($me, 'S-1-5-18', 'S-1-5-32-544')
      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
      $d.sessionAcl = @($rules | ForEach-Object { "$($_.AccessControlType) $($_.IdentityReference.Value) $($_.FileSystemRights) inherited=$($_.IsInherited)" })
      $d.sessionAclProtected = $acl.AreAccessRulesProtected
      $loose = @($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or $_.IsInherited -or $allowed -notcontains $_.IdentityReference.Value })
      $d.sessionOwnerOnly = [bool]($acl.AreAccessRulesProtected -and $loose.Count -eq 0 -and $rules.Count -gt 0)
      if (-not $d.sessionOwnerOnly) { $fail += 'session file ACL is not owner-only' }
    } else { $fail += 'session file missing' }

    $un = Join-Path $instDir 'Uninstall RealBud.exe'
    $tu = Get-Date
    Start-Process -FilePath $un -ArgumentList '/S' | Out-Null
    # The NSIS uninstaller re-launches itself from TEMP, so wait on its effects.
    while ((Since $tu) -lt 180 -and ((Test-Path -LiteralPath $exe) -or @(Get-RealBudProcesses).Count -gt 0)) { Start-Sleep -Seconds 2 }
    Start-Sleep -Seconds 5
    $left = @(Get-RealBudProcesses)
    $d.uninstallSeconds = Since $tu
    $d.appRemoved = -not (Test-Path -LiteralPath $exe)
    $d.leftoverProcesses = @($left | ForEach-Object { "$($_.Name) pid=$($_.ProcessId) $(Clip $_.CommandLine 160)" })
    $d.healthAfterUninstall = [bool](Health)
    $d.dataDirKept = Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.realbud')
    if (-not $d.appRemoved) { $fail += 'uninstall left RealBud.exe' }
    if ($left.Count) { $fail += "uninstall left $($left.Count) running process(es)" }
    if ($d.healthAfterUninstall) { $fail += 'service still answers after uninstall' }
    $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { $fail += "error: $(Clip $_.Exception.Message)" }
  $d.seconds = Since $t
  $d.failures = $fail
  Result 'smoke' $(if ($fail.Count) { 'FAIL' } else { 'PASS' }) $d
  if ($fail.Count) {
    $roam = Join-Path $env:APPDATA 'RealBud\logs'
    Tail 'smoke' (Join-Path $roam 'server.log') 30
    Tail 'smoke' (Join-Path $roam 'office-service\stdout-stderr.log') 40
  }
}

# -- source at the ref ------------------------------------------------------
$srcOk = $false
if ($setupOk -and ((Want 'unit') -or (Want 'dayone') -or (Want 'kevin') -or (Want 'chaos'))) {
  $t = Get-Date
  $r = Exec 'fetch' "git init -q src && cd src && git config core.longpaths true && git remote add origin $Repo && git fetch --progress --depth 1 origin $Ref && git checkout -q FETCH_HEAD && git log -1 --format=%H%n%s" 10 $Work
  # [string]: Get-Content lines carry PSProvider/PSDrive note properties, which
  # make ConvertTo-Json in Windows PowerShell 5.1 walk a huge graph and hang.
  $head = @(Get-Content -LiteralPath $r.log -ErrorAction SilentlyContinue | ForEach-Object { [string]$_ })
  if ($r.code -eq 0) { Result 'fetch' 'PASS' ([ordered]@{ ref = $Ref; sha = $head[-2]; subject = (Clip $head[-1] 120); seconds = (Since $t) }) }
  else { Result 'fetch' 'FAIL' @{ ref = $Ref; exit = $r.code }; Tail 'fetch' $r.log 20 }
  if ($r.code -eq 0) {
    $t = Get-Date
    $r = Exec 'install' "pnpm --version && pnpm install --frozen-lockfile --store-dir $Q\pnpm-store" 40
    if ($r.code -eq 0) { $srcOk = $true; Result 'pnpm-install' 'PASS' @{ seconds = (Since $t) } }
    else { Result 'pnpm-install' 'FAIL' @{ exit = $r.code; timedOut = $r.timedOut; seconds = (Since $t) }; Tail 'pnpm-install' $r.log 40 }
  }
}

# -- (b) typecheck and the Windows-sensitive vitest subset -----------------
if ($srcOk -and (Want 'unit')) {
  $t = Get-Date
  $r = Exec 'win-helpers' 'pnpm build:worker:win && pnpm build:cua-launcher:win' 10
  Result 'win-helpers' $(if ($r.code -eq 0) { 'PASS' } else { 'FAIL' }) @{ exit = $r.code; seconds = (Since $t) }
  if ($r.code -ne 0) { Tail 'win-helpers' $r.log 20 }

  $t = Get-Date
  $r = Exec 'typecheck' 'pnpm typecheck' 20
  $tsErrors = @(Select-String -LiteralPath $r.log -Pattern 'error TS\d+' -ErrorAction SilentlyContinue)
  Result 'typecheck' $(if ($r.code -eq 0) { 'PASS' } else { 'FAIL' }) ([ordered]@{ exit = $r.code; errors = $tsErrors.Count; first = @($tsErrors | Select-Object -First 10 | ForEach-Object { Clip $_.Line 240 }); seconds = (Since $t) })
  if ($r.code -ne 0 -and $tsErrors.Count -eq 0) { Tail 'typecheck' $r.log 30 }

  $t = Get-Date
  $json = Join-Path $Work 'vitest.json'
  $filters = 'server/windows-file-privacy server/atomic server/worker-custody server/office-link server/session-auth server/recovery-holds server/browser-authority server/store server/w1- server/w2-'
  $env:NODE_OPTIONS = '--max-old-space-size=6144'
  $r = Exec 'vitest' "pnpm exec vitest run $filters --reporter=default --reporter=json --outputFile=`"$json`"" 45
  Remove-Item Env:\NODE_OPTIONS
  if (Test-Path -LiteralPath $json) {
    $v = Get-Content -Raw -LiteralPath $json | ConvertFrom-Json
    $failed = @()
    foreach ($file in $v.testResults) {
      $rel = ([string]$file.name).Replace($Src, '').Replace($Src.Replace('\', '/'), '').TrimStart('\', '/')
      $bad = @($file.assertionResults | Where-Object { $_.status -eq 'failed' })
      foreach ($a in $bad) { $first = ([string]($a.failureMessages | Select-Object -First 1) -split "`n")[0]; $failed += "$rel > $($a.fullName): $first" }
      if ($file.status -eq 'failed' -and $bad.Count -eq 0) { $first = ([string]$file.message -split "`n")[0]; $failed += "$rel (file failed to run): $first" }
    }
    Result 'vitest' $(if ($r.code -eq 0 -and $v.numFailedTests -eq 0 -and $v.numFailedTestSuites -eq 0) { 'PASS' } else { 'FAIL' }) ([ordered]@{
      exit = $r.code; files = @($v.testResults).Count; tests = $v.numTotalTests; passed = $v.numPassedTests; failed = $v.numFailedTests
      skipped = $v.numPendingTests; todo = $v.numTodoTests; failedSuites = $v.numFailedTestSuites; seconds = (Since $t) })
    $failed | Select-Object -First 60 | ForEach-Object { Say "RBQA-LOG vitest | FAIL $(Clip $_ 300)" }
  } else { Result 'vitest' 'FAIL' @{ exit = $r.code; timedOut = $r.timedOut; error = 'no JSON report'; seconds = (Since $t) }; Tail 'vitest' $r.log 40 }
}

# -- (c) Austin day-one rehearsal on fictional data ------------------------
if ($srcOk -and (Want 'dayone')) {
  $t = Get-Date
  $env:QA_OUTPUT = Join-Path $Out 'austin-day-one'
  $r = Exec 'dayone' 'node scripts\qa-austin-day-one.mjs' 20
  Remove-Item Env:\QA_OUTPUT
  $receipt = Join-Path $Out 'austin-day-one\receipt.json'
  if (Test-Path -LiteralPath $receipt) {
    $rc = Get-Content -Raw -LiteralPath $receipt | ConvertFrom-Json
    $dayoneSteps = @($rc.steps)
    $counts = [ordered]@{}; foreach ($s in $dayoneSteps) { $counts[[string]$s.status] = 1 + [int]$counts[[string]$s.status] }
    Result 'dayone' $(if ($r.code -eq 0 -and @($dayoneSteps | Where-Object { $_.status -ne 'PASS' }).Count -eq 0) { 'PASS' } else { 'FAIL' }) ([ordered]@{
      exit = $r.code; counts = $counts; notPassed = @($dayoneSteps | Where-Object { $_.status -ne 'PASS' } | ForEach-Object { "$($_.n). $($_.name) [$($_.status)]: $(Clip $_.detail 300)" }); seconds = (Since $t) })
  } else { Result 'dayone' 'FAIL' @{ exit = $r.code; timedOut = $r.timedOut; error = 'no receipt written'; seconds = (Since $t) } }
  if ($r.code -ne 0) { Tail 'dayone' $r.log 40 }
}

# -- Kevin's workflow scripts (fictional providers; renderer ones drive Edge) --
# The renderer scripts need a built UI (this VM's own checkout, never a shared
# dist/) and Playwright; playwright-core is pinned and uses the preinstalled
# Edge, so no browser is downloaded. A script missing from the ref is skipped.
$KevinScripts = 'qa-kevin-day', 'qa-w1-simulated', 'qa-weekly-bills', 'qa-source-bills', 'qa-w2-calendar', 'qa-rei-login-wait', 'qa-rei-signin-wait', 'qa-bank-amendments'
if ($srcOk -and (Want 'kevin')) {
  $t = Get-Date
  $pw = Join-Path $Q 'tools\playwright-core-1.60.0'
  $r = Exec 'kevin-prep' "pnpm exec vite build && (if not exist `"$pw\node_modules\playwright-core\index.mjs`" npm install --prefix `"$pw`" playwright-core@1.60.0 --no-audit --no-fund --no-save)" 20
  $prepOk = $r.code -eq 0
  Result 'kevin-prep' $(if ($prepOk) { 'PASS' } else { 'FAIL' }) @{ exit = $r.code; seconds = (Since $t) }
  if (-not $prepOk) { Tail 'kevin-prep' $r.log 30 }
  $env:PLAYWRIGHT_MODULE = ([Uri](Join-Path $pw 'node_modules\playwright-core\index.mjs')).AbsoluteUri
  $env:REALBUD_UI_DIR = Join-Path $Src 'dist'
  foreach ($name in $KevinScripts) {
    if (-not (Test-Path -LiteralPath (Join-Path $Src "scripts\$name.mjs"))) { Result "kevin:$name" 'SKIP' @{ reason = 'not in this ref' }; continue }
    if ($name -ne 'qa-kevin-day' -and -not $prepOk) { Result "kevin:$name" 'NOT RUN' @{ reason = 'kevin-prep failed' }; continue }
    $t = Get-Date
    $env:QA_OUTPUT = Join-Path $Out $name
    $r = Exec $name "node scripts\$name.mjs" 8
    Remove-Item Env:\QA_OUTPUT
    $data = [ordered]@{ exit = $r.code; timedOut = $r.timedOut; seconds = (Since $t) }
    $summary = Select-String -LiteralPath $r.log -Pattern '(PASSED|FAILED) . (\d+)/(\d+) checks' | Select-Object -Last 1
    if ($summary) { $data.passed = [int]$summary.Matches[0].Groups[2].Value; $data.checks = [int]$summary.Matches[0].Groups[3].Value }
    Result "kevin:$name" $(if ($r.code -eq 0) { 'PASS' } else { 'FAIL' }) $data
    if ($r.code -ne 0) {
      @(Select-String -LiteralPath $r.log -Pattern '^FAIL ' | Select-Object -First 20) | ForEach-Object { Say "RBQA-LOG $name | $(Clip $_.Line 300)" }
      Tail $name $r.log 25
    }
  }
  Remove-Item Env:\PLAYWRIGHT_MODULE, Env:\REALBUD_UI_DIR -ErrorAction SilentlyContinue
}

# -- (d) chaos cases (disk-full N/A on Windows; sleep/wake via NtSuspendProcess)
if ($srcOk -and (Want 'chaos')) {
  $t = Get-Date
  $r = Exec 'chaos' "node scripts\resilience\chaos.mjs --out `"$Out\chaos`"" 25
  $receipt = Join-Path $Out 'chaos\receipt.json'
  if (Test-Path -LiteralPath $receipt) {
    $rc = Get-Content -Raw -LiteralPath $receipt | ConvertFrom-Json
    $cases = @($rc.cases)
    $notPassed = @()
    foreach ($c in ($cases | Where-Object { $_.result -ne 'PASS' })) {
      $why = @($c.checks | Where-Object { -not $_.ok } | ForEach-Object { "$($_.name) -- $($_.detail)" }) + @($c.error, $c.reason) | Where-Object { $_ }
      $notPassed += "$($c.id) $($c.name) [$($c.result)]: $(Clip ($why -join ' | ') 500)"
    }
    Result 'chaos' $(if (@($cases | Where-Object { $_.result -eq 'FAIL' }).Count -eq 0) { 'PASS' } else { 'FAIL' }) ([ordered]@{
      exit = $r.code; pass = @($rc.summary.PASS); fail = @($rc.summary.FAIL); na = @($rc.summary.'N/A'); notPassed = $notPassed
      cleanup = $rc.cleanup; seconds = (Since $t) })
  } else { Result 'chaos' 'FAIL' @{ exit = $r.code; timedOut = $r.timedOut; error = 'no receipt written'; seconds = (Since $t) } }
  if ($r.code -ne 0) { Tail 'chaos' $r.log 40 }
}

Result 'run' 'DONE' @{ seconds = (Since $runStart) }
Say "RBQA-DONE $Run"
