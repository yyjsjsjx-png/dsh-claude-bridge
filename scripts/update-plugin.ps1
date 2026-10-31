[CmdletBinding()]
param(
    [string]$DshExecutable,
    [string]$DshHome,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')]
    [string]$Profile = 'desktop',
    [string]$PackageDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $PackageDirectory) { $PackageDirectory = Split-Path -Parent $PSScriptRoot }
. (Join-Path $PSScriptRoot 'resolve-dsh-executable.ps1')
$DshExecutable = Resolve-BridgeDshExecutable $DshExecutable
$BridgeExecutable = (Resolve-Path -LiteralPath $DshExecutable).Path
$BridgeResources = Join-Path (Split-Path -Parent $BridgeExecutable) 'resources'
$BridgePackage = (Resolve-Path -LiteralPath $PackageDirectory).Path
$BridgeUpdater = Join-Path $PSScriptRoot 'update-plugin.mjs'
if (-not $DshHome) {
    $DshHome = $env:DSH_HOME
    if (-not $DshHome) { $DshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
}
$BridgeHome = [IO.Path]::GetFullPath($DshHome)
$BridgeProfile = Join-Path $BridgeHome ('profiles\' + $Profile)
if (-not (Test-Path -LiteralPath (Join-Path $BridgeProfile 'package.json') -PathType Leaf)) {
    throw '目标 DSH 配置不存在，请先确认安装目录和 DshHome。'
}

$BridgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | Where-Object {
    $_.ExecutablePath -eq $BridgeExecutable -and (
        ($_.CommandLine -match ('--profile(?:=|\s+)"?' + [regex]::Escape($Profile) + '(?:"|\s|$)')) -or
        ($Profile -eq 'desktop' -and $_.CommandLine -notmatch '--profile(?:=|\s+)')
    )
})
if ($BridgeProcesses.Count -gt 0) { throw '请先完全退出使用此配置的 DSH，再运行更新；脚本不会强制终止程序。' }

$BridgeLogDirectory = Join-Path $BridgeProfile '.plugin-manager\logs'
$null = New-Item -ItemType Directory -Path $BridgeLogDirectory -Force
$BridgeLogPrefix = Join-Path $BridgeLogDirectory ('bridge-updater-' + [Guid]::NewGuid().ToString('N'))
$BridgeArguments = @('--expose-internals', $BridgeUpdater, '--resources', $BridgeResources,
    '--home', $BridgeHome, '--profile', $Profile, '--package', $BridgePackage)
# All values are filesystem paths or validated profile identifiers. Windows filenames cannot contain quotes.
$BridgeCommandLine = ($BridgeArguments | ForEach-Object { '"' + [regex]::Replace($_, '(\\+)$', '$1$1') + '"' }) -join ' '
$BridgePreviousElectron = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    Write-Host '正在使用 DSH 自带包管理器原地更新，请稍候。'
    try {
        $BridgeProcess = Start-Process -FilePath $BridgeExecutable -ArgumentList $BridgeCommandLine `
            -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput ($BridgeLogPrefix + '.out') `
            -RedirectStandardError ($BridgeLogPrefix + '.err')
    } catch {
        $BridgeLaunchError = $_.Exception
        for ($BridgeDepth = 0; $null -ne $BridgeLaunchError -and $BridgeDepth -lt 16; $BridgeDepth++) {
            if ($BridgeLaunchError -is [ComponentModel.Win32Exception] -and $BridgeLaunchError.NativeErrorCode -eq 740) {
                $BridgeElevationMessage = 'Windows 要求提升权限，本次更新尚未启动。请完全退出 DSH，以管理员身份打开 PowerShell 后重跑同一条更新命令。'
                $BridgeElevationException = New-Object InvalidOperationException($BridgeElevationMessage, $BridgeLaunchError)
                $BridgeElevationRecord = New-Object Management.Automation.ErrorRecord($BridgeElevationException,
                    'BRIDGE_UPDATE_ELEVATION_REQUIRED', [Management.Automation.ErrorCategory]::PermissionDenied, $BridgeExecutable)
                $PSCmdlet.ThrowTerminatingError($BridgeElevationRecord)
            }
            $BridgeLaunchError = $BridgeLaunchError.InnerException
        }
        throw
    }
    $BridgeProcess.WaitForExit()
    $BridgeProcess.Refresh()
    if ($null -eq $BridgeProcess.ExitCode -or $BridgeProcess.ExitCode -ne 0) {
        $BridgeFailureSummary = ''
        try {
            if (Test-Path -LiteralPath ($BridgeLogPrefix + '.err') -PathType Leaf) {
                $BridgeFailureSummary = (Get-Content -LiteralPath ($BridgeLogPrefix + '.err') -Raw -Encoding UTF8).Trim()
            }
        } catch { # Failure to read a summary must not hide the original update failure.
        }
        if (-not $BridgeFailureSummary) { $BridgeFailureSummary = '更新未完成，未取得详细错误摘要。' }
        throw ($BridgeFailureSummary + [Environment]::NewLine + '更新器错误日志：' + $BridgeLogPrefix + '.err' +
            [Environment]::NewLine + '更新器输出日志：' + $BridgeLogPrefix + '.out')
    }
    $BridgeResult = Get-Content -LiteralPath ($BridgeLogPrefix + '.out') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $BridgeResult.updated) { throw '更新结果未确认，请检查更新日志。' }
    Write-Host ('已更新：' + $BridgeResult.previousVersion + ' -> ' + $BridgeResult.version)
    Write-Host ('安装元数据备份：' + $BridgeResult.backup)
    Write-Host '会话、连接和设备身份保留。现在可重新启动 DSH。'
} finally {
    $env:ELECTRON_RUN_AS_NODE = $BridgePreviousElectron
}
