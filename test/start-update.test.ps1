$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$project = Split-Path $PSScriptRoot
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-bridge-launcher-' + [Guid]::NewGuid().ToString('N'))
$candidate = Join-Path $temporaryRoot '中文 空格候选包'
$scripts = Join-Path $candidate 'scripts'
$fakeLocalAppData = Join-Path $temporaryRoot '原用户 AppData'
$fakeExecutable = Join-Path $fakeLocalAppData 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
$fakeHome = Join-Path $temporaryRoot '原用户 数据目录'
foreach ($directory in @($scripts, (Split-Path $fakeExecutable), $fakeHome)) { [void][IO.Directory]::CreateDirectory($directory) }
[IO.File]::WriteAllText($fakeExecutable, '')
$encoding = New-Object Text.UTF8Encoding($true)
$launcher = Join-Path $scripts 'start-update.ps1'
[IO.File]::WriteAllText($launcher, [IO.File]::ReadAllText((Join-Path $project 'scripts\start-update.ps1')), $encoding)
$stub = @'
[CmdletBinding()]
param([string]$DshExecutable, [string]$DshHome, [string]$Profile, [string]$PackageDirectory)
$fixture = Split-Path $PSScriptRoot
$scenario = [IO.File]::ReadAllText((Join-Path $fixture 'scenario.txt'))
$call = [ordered]@{ DshExecutable = $DshExecutable; DshHome = $DshHome; Profile = $Profile; PackageDirectory = $PackageDirectory }
[IO.File]::AppendAllText((Join-Path $fixture 'calls.jsonl'), ($call | ConvertTo-Json -Compress) + [Environment]::NewLine)
if ($scenario -eq 'elevation') {
    $exception = New-Object InvalidOperationException('合成 740，需要管理员权限')
    $record = New-Object Management.Automation.ErrorRecord($exception, 'BRIDGE_UPDATE_ELEVATION_REQUIRED', [Management.Automation.ErrorCategory]::PermissionDenied, $DshExecutable)
    $PSCmdlet.ThrowTerminatingError($record)
}
if ($scenario -eq 'failed') { throw '合成安装失败（文本含740但不可提权重试）；安装日志：FAKE_OPERATION\pnpm.log' }
Write-Host '合成成功：0.1.3 -> 0.1.4-rc.2'
'@
[IO.File]::WriteAllText((Join-Path $scripts 'update-plugin.ps1'), $stub, $encoding)
$captureScript = Join-Path $scripts 'capture-arguments.ps1'
$capture = @'
param([string]$DshExecutable, [string]$DshHome, [string]$Profile, [string]$PackageDirectory, [switch]$Elevated)
[ordered]@{ DshExecutable = $DshExecutable; DshHome = $DshHome; Profile = $Profile; PackageDirectory = $PackageDirectory; Elevated = [bool]$Elevated } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'captured-targets.json') -Encoding UTF8
'@
[IO.File]::WriteAllText($captureScript, $capture, $encoding)
$originalLocalAppData = $env:LOCALAPPDATA
$originalDshHome = $env:DSH_HOME
$launcherState = @{ uacCalls = 0; pauses = 0; cancel = $false; arguments = ''; filePath = '' }

function Assert-Launcher([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Read-Host {
    param([string]$Prompt)
    Assert-Launcher ($Prompt.Contains('按回车关闭窗口')) '结果窗口没有等待关闭'
    $launcherState.pauses++
    return ''
}
function Start-Process {
    param([string]$FilePath, [string]$ArgumentList, [string]$Verb, [string]$WindowStyle, [switch]$Wait, [switch]$PassThru)
    $launcherState.uacCalls++
    Assert-Launcher ($Verb -eq 'RunAs' -and $WindowStyle -eq 'Normal' -and $Wait -and $PassThru) '管理员窗口不是可见交互窗口'
    $launcherState.arguments = $ArgumentList
    $launcherState.filePath = $FilePath
    # Simulate a different administrator's environment after target resolution.
    $env:LOCALAPPDATA = Join-Path $temporaryRoot '另一个管理员 AppData'
    $env:DSH_HOME = Join-Path $temporaryRoot '另一个管理员 Home'
    if ($launcherState.cancel) { throw (New-Object ComponentModel.Win32Exception(1223)) }
    $process = [PSCustomObject]@{ ExitCode = 0 }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    return $process
}
function Invoke-LauncherCase([string]$Scenario, [bool]$UseDefaults = $false, [bool]$CancelUac = $false, [bool]$AlreadyElevated = $false) {
    $env:LOCALAPPDATA = $fakeLocalAppData
    $env:DSH_HOME = $fakeHome
    $launcherState.uacCalls = 0; $launcherState.pauses = 0; $launcherState.cancel = $CancelUac; $launcherState.arguments = ''
    [IO.File]::WriteAllText((Join-Path $candidate 'scenario.txt'), $Scenario)
    [IO.File]::WriteAllText((Join-Path $candidate 'calls.jsonl'), '')
    $parameters = @{}
    if (-not $UseDefaults) { $parameters = @{ DshExecutable = $fakeExecutable; DshHome = $fakeHome; Profile = 'custom-profile'; PackageDirectory = $candidate } }
    if ($AlreadyElevated) { $parameters.Elevated = $true }
    $output = @(& $launcher @parameters 6>&1)
    $resultCode = $LASTEXITCODE
    $calls = @(Get-Content -LiteralPath (Join-Path $candidate 'calls.jsonl') -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-Launcher ($calls.Count -eq 1) '入口重复执行了更新逻辑'
    Assert-Launcher ($calls[0].DshExecutable -eq $fakeExecutable -and $calls[0].DshHome -eq $fakeHome -and $calls[0].PackageDirectory -eq $candidate) '目标参数传递错误'
    $expectedProfile = if ($UseDefaults) { 'desktop' } else { 'custom-profile' }
    Assert-Launcher ($calls[0].Profile -eq $expectedProfile) 'Profile 参数丢失'
    return @{ output = ($output -join [Environment]::NewLine); code = $resultCode }
}

try {
    $result = Invoke-LauncherCase 'success'
    Assert-Launcher ($result.code -eq 0 -and $launcherState.pauses -eq 1 -and $launcherState.uacCalls -eq 0) '成功后未保留结果窗口或错误提权'
    Write-Output '自定义四参数及成功结果等待关闭：通过'
    $result = Invoke-LauncherCase 'failed'
    Assert-Launcher ($result.code -eq 1 -and $launcherState.pauses -eq 1 -and $launcherState.uacCalls -eq 0 -and $result.output.Contains('FAKE_OPERATION\pnpm.log')) '安装失败没有保留错误，或仅凭740文本重试'
    Write-Output '安装失败保留日志和窗口且不提权重试：通过'
    $result = Invoke-LauncherCase 'elevation' $true
    Assert-Launcher ($result.code -eq 0 -and $launcherState.uacCalls -eq 1 -and $launcherState.pauses -eq 0) '740 未交给唯一管理员结果窗口'
    $forwardedArguments = $launcherState.arguments
    Write-Output '仅结构化740请求一次UAC：通过'
    # Parse the actual forwarded Windows command line in a harmless capture
    # process, without UAC and without invoking either updater or DSH.
    $captureArguments = $forwardedArguments.Replace($launcher, $captureScript)
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $launcherState.filePath
    $startInfo.Arguments = $captureArguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $captureProcess = [Diagnostics.Process]::Start($startInfo)
    try {
        if (-not $captureProcess.WaitForExit(5000)) { $captureProcess.Kill(); $captureProcess.WaitForExit(); throw '参数捕获进程超时' }
        Assert-Launcher ($captureProcess.ExitCode -eq 0) '中文空格目录命令行解析失败'
    } finally { $captureProcess.Dispose() }
    $forwarded = Get-Content -LiteralPath (Join-Path $scripts 'captured-targets.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Launcher ($forwarded.DshExecutable -eq $fakeExecutable -and $forwarded.DshHome -eq $fakeHome -and $forwarded.Profile -eq 'desktop' -and $forwarded.PackageDirectory -eq $candidate -and $forwarded.Elevated) '提权后目标受管理员环境影响或参数转义错误'
    Write-Output '默认目标提权前固定且中文空格路径实际传参：通过'
    $result = Invoke-LauncherCase 'elevation' $true $true
    Assert-Launcher ($result.code -eq 1 -and $launcherState.uacCalls -eq 1 -and $launcherState.pauses -eq 1 -and $result.output.Contains('已取消管理员授权，本次更新未执行')) 'UAC拒绝未明确说明未执行或窗口闪退'
    Write-Output 'UAC拒绝明确未执行并等待关闭：通过'
    $result = Invoke-LauncherCase 'elevation' $false $false $true
    Assert-Launcher ($result.code -eq 1 -and $launcherState.uacCalls -eq 0 -and $launcherState.pauses -eq 1) '管理员入口740发生循环提权'
    Write-Output '管理员入口失败不循环提权：通过'
    $result = Invoke-LauncherCase 'success' $false $false $true
    Assert-Launcher ($result.code -eq 0 -and $launcherState.pauses -eq 1 -and $launcherState.uacCalls -eq 0) '管理员成功窗口未等待关闭'
    Write-Output '管理员成功窗口等待关闭：通过'
    Write-Output ('Windows PowerShell {0}：双击入口纯模拟 7/7 通过；真实 UAC、DSH 及用户 Home 操作均为 0。' -f $PSVersionTable.PSVersion)
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:DSH_HOME = $originalDshHome
    $resolvedRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedRoot) -match '^dsh-bridge-launcher-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
