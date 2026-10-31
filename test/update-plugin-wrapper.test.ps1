$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$wrapperPath = Join-Path (Split-Path $PSScriptRoot) 'scripts\update-plugin.ps1'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-bridge-wrapper-' + [Guid]::NewGuid().ToString('N'))
$fakeExecutable = Join-Path $temporaryRoot 'application\DeepSeek Harness.exe'
$fakeHome = Join-Path $temporaryRoot 'fake-home'
$fakePackage = Join-Path $temporaryRoot 'candidate-package'
$fakeProfile = Join-Path $fakeHome 'profiles\desktop'
foreach ($directory in @((Split-Path $fakeExecutable), $fakeProfile, $fakePackage)) {
    [void][IO.Directory]::CreateDirectory($directory)
}
[IO.File]::WriteAllText($fakeExecutable, '')
[IO.File]::WriteAllText((Join-Path $fakeProfile 'package.json'), '{}')
$wrapperState = @{ scenario = ''; starts = 0; lastErrorLog = ''; lastOutputLog = '' }
$originalElectron = $env:ELECTRON_RUN_AS_NODE

function Assert-Wrapper([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-CimInstance {
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne 'Win32_Process') { throw '不得读取真实进程' }
    return @()
}
function Start-Process {
    param([string]$FilePath, [string]$ArgumentList, [string]$WindowStyle,
        [switch]$Wait, [switch]$PassThru, [string]$RedirectStandardOutput, [string]$RedirectStandardError)
    $wrapperState.starts++
    Assert-Wrapper ($FilePath -eq $fakeExecutable) '启动目标不是临时假程序'
    Assert-Wrapper ($env:ELECTRON_RUN_AS_NODE -eq '1') '未向子进程设置 Electron Node 模式'
    Assert-Wrapper ($ArgumentList.Contains($fakeHome) -and $ArgumentList.Contains($fakePackage)) '未保留测试目录参数'
    $wrapperState.lastErrorLog = $RedirectStandardError
    $wrapperState.lastOutputLog = $RedirectStandardOutput
    if ($wrapperState.scenario -eq 'elevation') {
        $native = New-Object ComponentModel.Win32Exception(740)
        throw (New-Object InvalidOperationException('合成外层异常', $native))
    }
    if ($wrapperState.scenario -eq 'failed') {
        $summary = '更新未完成。安装元数据备份：FAKE_BACKUP；安装日志：FAKE_PROFILE\.plugin-manager\logs\operation-FAKE\pnpm.log。'
        [IO.File]::WriteAllText($RedirectStandardError, $summary, (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($RedirectStandardOutput, '')
        $exitCode = 1
    }
    else {
        [IO.File]::WriteAllText($RedirectStandardError, '')
        [IO.File]::WriteAllText($RedirectStandardOutput, '{"updated":true,"previousVersion":"0.1.3","version":"0.1.4-rc.1","backup":"FAKE_BACKUP"}', (New-Object Text.UTF8Encoding($false)))
        $exitCode = 0
    }
    $process = [PSCustomObject]@{ ExitCode = $exitCode }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    return $process
}

function Invoke-WrapperCase([string]$Scenario, [bool]$UnsetEnvironment = $false) {
    $wrapperState.scenario = $Scenario
    $wrapperState.starts = 0
    if ($UnsetEnvironment) { $env:ELECTRON_RUN_AS_NODE = $null }
    else { $env:ELECTRON_RUN_AS_NODE = 'original-test-value' }
    $expectedEnvironment = $env:ELECTRON_RUN_AS_NODE
    $failure = ''
    $failureId = ''
    $output = @()
    try {
        $output = @(& $wrapperPath -DshExecutable $fakeExecutable -DshHome $fakeHome -PackageDirectory $fakePackage 6>&1)
    }
    catch { $failure = $_.Exception.Message; $failureId = $_.FullyQualifiedErrorId }
    Assert-Wrapper ($wrapperState.starts -eq 1) ('更新器启动次数异常：' + $wrapperState.starts + '；模拟异常：' + $failure)
    Assert-Wrapper ($env:ELECTRON_RUN_AS_NODE -eq $expectedEnvironment) 'ELECTRON_RUN_AS_NODE 原值未恢复'
    if ($Scenario -eq 'elevation') {
        Assert-Wrapper ($failure.Contains('本次更新尚未启动') -and $failure.Contains('以管理员身份打开 PowerShell')) '740 未给出明确处理提示'
        Assert-Wrapper (($failureId -split ',')[0] -eq 'BRIDGE_UPDATE_ELEVATION_REQUIRED') '740 缺少结构化错误标识'
    }
    elseif ($Scenario -eq 'failed') {
        Assert-Wrapper ($failure.Contains('operation-FAKE\pnpm.log') -and $failure.Contains('FAKE_BACKUP')) '安装失败摘要或实际 pnpm 日志路径未显示'
        Assert-Wrapper ($failure.Contains($wrapperState.lastErrorLog) -and $failure.Contains($wrapperState.lastOutputLog)) '更新器自身日志路径未保留'
    }
    else {
        Assert-Wrapper (-not $failure) '成功路径报错'
        Assert-Wrapper (($output -join [Environment]::NewLine).Contains('0.1.3 -> 0.1.4-rc.1')) '成功版本结果未显示'
    }
}

try {
    Invoke-WrapperCase 'elevation'
    Write-Output '异常链 740 提示且不重试、环境原值恢复：通过'
    Invoke-WrapperCase 'failed'
    Write-Output '非零退出展示摘要及两层日志路径、环境原值恢复：通过'
    Invoke-WrapperCase 'success'
    Write-Output '成功结果及环境原值恢复：通过'
    Invoke-WrapperCase 'elevation' $true
    Write-Output '原先未设置的环境变量在失败后恢复为空：通过'
    Write-Output ('Windows PowerShell {0}：更新器 wrapper 纯模拟 4/4 通过；真实 DSH 启动 0 次。' -f $PSVersionTable.PSVersion)
}
finally {
    $env:ELECTRON_RUN_AS_NODE = $originalElectron
    # Delete only the verified, unique directory created by this test.
    $resolvedRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedRoot) -match '^dsh-bridge-wrapper-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
