# Read installation metadata only; never execute registry or shortcut commands.
function Resolve-BridgeDshExecutable {
    param([string]$ExplicitPath)
    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) { throw '指定的 DSH 程序不存在。' }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }
    $BridgeCandidates = @()
    $BridgeRegistryRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
    foreach ($BridgeEntry in @(Get-ItemProperty -Path $BridgeRegistryRoots -ErrorAction SilentlyContinue)) {
        if ($BridgeEntry.PSObject.Properties['DisplayName'] -and $BridgeEntry.DisplayName -match '^DeepSeek Harness(?:\s|$)') {
            if ($BridgeEntry.PSObject.Properties['InstallLocation'] -and $BridgeEntry.InstallLocation) {
                $BridgeCandidates += Join-Path $BridgeEntry.InstallLocation 'DeepSeek Harness.exe'
            }
            if ($BridgeEntry.PSObject.Properties['DisplayIcon'] -and $BridgeEntry.DisplayIcon) {
                $BridgeIcon = [string]$BridgeEntry.DisplayIcon
                if ($BridgeIcon -match '^"([^"]+\.exe)"(?:,\s*-?\d+)?$') { $BridgeCandidates += $Matches[1] }
                elseif ($BridgeIcon -match '^(.+\.exe)(?:,\s*-?\d+)?$') { $BridgeCandidates += $Matches[1] }
            }
        }
    }
    $BridgeShortcutRoots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'),
        [Environment]::GetFolderPath('Desktop')) | Where-Object { $_ }
    $BridgeShell = $null
    try {
        foreach ($BridgeRoot in $BridgeShortcutRoots) {
            foreach ($BridgeRelative in @('DeepSeek Harness.lnk', 'DeepSeek Harness\DeepSeek Harness.lnk')) {
                $BridgeShortcutPath = Join-Path $BridgeRoot $BridgeRelative
                if (Test-Path -LiteralPath $BridgeShortcutPath -PathType Leaf) {
                    if ($null -eq $BridgeShell) { $BridgeShell = New-Object -ComObject WScript.Shell }
                    $BridgeCandidates += $BridgeShell.CreateShortcut($BridgeShortcutPath).TargetPath
                }
            }
        }
    } catch { # Registry and validated defaults remain available if COM is unavailable.
    } finally { if ($null -ne $BridgeShell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($BridgeShell) } }
    if ($env:LOCALAPPDATA) { $BridgeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
    $BridgeFound = @($BridgeCandidates | Where-Object {
        $_ -and [IO.Path]::IsPathRooted($_) -and [IO.Path]::GetFileName($_) -eq 'DeepSeek Harness.exe' -and
        (Test-Path -LiteralPath $_ -PathType Leaf)
    } | ForEach-Object { (Resolve-Path -LiteralPath $_).Path } | Sort-Object -Unique)
    if ($BridgeFound.Count -eq 1) { return $BridgeFound[0] }
    if ($BridgeFound.Count -gt 1) { throw '发现多个 DSH 安装，请用 -DshExecutable 明确指定；未执行更新。' }
    throw '未找到 DSH 安装，请用 -DshExecutable 指定现有程序；未执行更新。'
}
