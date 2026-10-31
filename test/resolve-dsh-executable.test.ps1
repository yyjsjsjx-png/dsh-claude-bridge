$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path $PSScriptRoot) 'scripts\resolve-dsh-executable.ps1')
$BridgeTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-path-' + [Guid]::NewGuid().ToString('N'))
$BridgeCustom = Join-Path $BridgeTestRoot 'custom install\DeepSeek Harness.exe'
$BridgeOther = Join-Path $BridgeTestRoot 'other install\DeepSeek Harness.exe'
$BridgeOldLocal = $env:LOCALAPPDATA
$BridgeRows = @()
function Get-ItemProperty { param($Path,$ErrorAction) return $BridgeRows }
function Test-BridgePath([bool]$Condition) { if (-not $Condition) { throw '安装路径识别检查失败' } }
try {
    [void][IO.Directory]::CreateDirectory((Split-Path $BridgeCustom))
    [void][IO.Directory]::CreateDirectory((Split-Path $BridgeOther))
    [IO.File]::WriteAllText($BridgeCustom, '')
    [IO.File]::WriteAllText($BridgeOther, '')
    $env:LOCALAPPDATA = Join-Path $BridgeTestRoot 'missing-default'
    # Filter real shortcuts/defaults so this fixture cannot select a real app.
    function Test-Path { param($LiteralPath,$PathType) return $LiteralPath -in @($BridgeCustom,$BridgeOther) }
    Test-BridgePath ((Resolve-BridgeDshExecutable $BridgeCustom) -eq $BridgeCustom)
    $BridgeRows = @([PSCustomObject]@{ DisplayName = 'DeepSeek Harness 0.2.1-rc.5'; InstallLocation = (Split-Path $BridgeCustom) })
    Test-BridgePath ((Resolve-BridgeDshExecutable) -eq $BridgeCustom)
    $BridgeRows = @([PSCustomObject]@{ DisplayName = 'DeepSeek Harness'; DisplayIcon = ('"' + $BridgeCustom + '",0') })
    Test-BridgePath ((Resolve-BridgeDshExecutable) -eq $BridgeCustom)
    $BridgeRows += [PSCustomObject]@{ DisplayName = 'DeepSeek Harness 0.2'; InstallLocation = (Split-Path $BridgeOther) }
    $BridgeRejected = $false
    try { Resolve-BridgeDshExecutable | Out-Null } catch { $BridgeRejected = $_.Exception.Message.Contains('多个') }
    Test-BridgePath $BridgeRejected
    $BridgeRows = @()
    $BridgeRejected = $false
    try { Resolve-BridgeDshExecutable | Out-Null } catch { $BridgeRejected = $_.Exception.Message.Contains('未找到') }
    Test-BridgePath $BridgeRejected
    Write-Output '安装路径识别5/5通过：显式路径、自定义安装、图标路径、歧义拒绝、缺失拒绝。'
} finally {
    $env:LOCALAPPDATA = $BridgeOldLocal
    $BridgeAbsolute = [IO.Path]::GetFullPath($BridgeTestRoot)
    $BridgeTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($BridgeAbsolute.StartsWith($BridgeTemp,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $BridgeAbsolute) -match '^dsh-path-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $BridgeAbsolute -Recurse -Force
    }
}
