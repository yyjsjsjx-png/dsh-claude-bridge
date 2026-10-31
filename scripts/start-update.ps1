[CmdletBinding()]
param(
    [string]$DshExecutable,
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [string]$PackageDirectory,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$BridgeExitCode = 1
$BridgeWaitForClose = $true
try {
    Write-Host 'DSH 远程 Claude 桥接插件更新' -ForegroundColor Cyan
    Write-Host '请先完全退出 DSH，包括托盘中的程序。'
    if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$') { throw '配置名称无效。' }
    # Resolve every target before UAC. A different administrator account must
    # never replace the original user's Home or installation with its defaults.
    if (-not $DshExecutable) { $DshExecutable = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
    if (-not $PackageDirectory) { $PackageDirectory = Split-Path -Parent $PSScriptRoot }
    if (-not $DshHome) {
        $DshHome = $env:DSH_HOME
        if (-not $DshHome) { $DshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
    }
    if (-not [IO.Path]::IsPathRooted($DshHome)) { $DshHome = Join-Path (Get-Location).Path $DshHome }
    $BridgeResolved = @{
        DshExecutable = (Resolve-Path -LiteralPath $DshExecutable).Path
        DshHome = [IO.Path]::GetFullPath($DshHome)
        Profile = $Profile
        PackageDirectory = (Resolve-Path -LiteralPath $PackageDirectory).Path
    }
    try {
        & (Join-Path $PSScriptRoot 'update-plugin.ps1') @BridgeResolved
        $BridgeExitCode = 0
    }
    catch {
        $BridgeErrorRecord = $_
        $BridgeNeedsElevation = ($BridgeErrorRecord.FullyQualifiedErrorId -split ',')[0] -eq 'BRIDGE_UPDATE_ELEVATION_REQUIRED'
        if (-not $BridgeNeedsElevation) { throw }
        if ($Elevated) { throw '已在管理员更新窗口中，仍无法启动更新器。本次更新尚未启动，请检查 DSH 安装权限。' }
        Write-Host 'Windows 要求管理员权限，正在请求 UAC；目标目录保持不变。' -ForegroundColor Yellow
        $BridgeRelaunchArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
            '-DshExecutable', $BridgeResolved.DshExecutable, '-DshHome', $BridgeResolved.DshHome,
            '-Profile', $BridgeResolved.Profile, '-PackageDirectory', $BridgeResolved.PackageDirectory, '-Elevated')
        # Windows filesystem paths cannot contain quotes. Escape trailing
        # backslashes so quoted root directories remain a single argument.
        $BridgeRelaunchCommand = ($BridgeRelaunchArguments | ForEach-Object { '"' + [regex]::Replace($_, '(\\+)$', '$1$1') + '"' }) -join ' '
        try {
            $BridgePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            # This is the user's interactive result window, intentionally visible.
            # UAC uses ShellExecute; stdout/stderr redirection stays in the wrapper.
            $BridgeElevatedProcess = Start-Process -FilePath $BridgePowerShell -ArgumentList $BridgeRelaunchCommand `
                -Verb RunAs -WindowStyle Normal -Wait -PassThru
            $BridgeElevatedProcess.WaitForExit()
            $BridgeElevatedProcess.Refresh()
            if ($null -ne $BridgeElevatedProcess.ExitCode) { $BridgeExitCode = [int]$BridgeElevatedProcess.ExitCode }
            $BridgeWaitForClose = $false
        }
        catch {
            $BridgeUacError = $_.Exception
            $BridgeUacCancelled = $false
            for ($BridgeDepth = 0; $null -ne $BridgeUacError -and $BridgeDepth -lt 16; $BridgeDepth++) {
                if ($BridgeUacError -is [ComponentModel.Win32Exception] -and $BridgeUacError.NativeErrorCode -eq 1223) { $BridgeUacCancelled = $true; break }
                $BridgeUacError = $BridgeUacError.InnerException
            }
            if ($BridgeUacCancelled) { throw '已取消管理员授权，本次更新未执行。' }
            throw '无法打开管理员更新窗口，本次更新未执行。请保留此提示并检查 Windows 权限。'
        }
    }
}
catch { Write-Host ('更新未完成：' + $_.Exception.Message) -ForegroundColor Red }
finally {
    if ($BridgeWaitForClose) {
        Write-Host ''
        [void](Read-Host '按回车关闭窗口')
    }
}
exit $BridgeExitCode
