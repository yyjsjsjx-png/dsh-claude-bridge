[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$DshExecutable,
    [string]$DshHome,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')][string]$Profile = 'desktop',
    [string]$InstallRoot,
    [uri]$Proxy
)

$ErrorActionPreference = 'Stop'

function Get-BridgeReleaseAssets {
    param($Release)
    if ($Release.draft -or $Release.prerelease -or $Release.tag_name -notmatch '^v(\d+\.\d+\.\d+)$') { throw '发布版本不是正式版本。' }
    $BridgeVersion = $Matches[1]
    $BridgeZipName = 'dsh-claude-bridge-' + $BridgeVersion + '.zip'
    $BridgeHashName = 'dsh-claude-bridge-' + $BridgeVersion + '.sha256'
    $BridgeZip = @($Release.assets | Where-Object { $_.name -eq $BridgeZipName })
    $BridgeHash = @($Release.assets | Where-Object { $_.name -eq $BridgeHashName })
    if ($BridgeZip.Count -ne 1 -or $BridgeHash.Count -ne 1) { throw '发布附件不完整，请稍后再试。' }
    $BridgeBase = 'https://github.com/yyjsjsjx-png/dsh-claude-bridge/releases/download/' + $Release.tag_name + '/'
    if ($BridgeZip[0].browser_download_url -cne ($BridgeBase + $BridgeZipName) -or
        $BridgeHash[0].browser_download_url -cne ($BridgeBase + $BridgeHashName)) { throw '发布附件地址不符合预期。' }
    return @{ Version = $BridgeVersion; Zip = $BridgeZip[0].browser_download_url; Hash = $BridgeHash[0].browser_download_url }
}

function Expand-BridgeVerifiedPackage {
    param([string]$Archive, [string]$HashFile, [string]$Destination, [string]$ExpectedVersion)
    $BridgeHashText = [IO.File]::ReadAllText($HashFile).Trim()
    $BridgeExpectedName = 'dsh-claude-bridge-' + $ExpectedVersion + '.zip'
    if ($BridgeHashText -notmatch ('^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($BridgeExpectedName) + '$')) { throw '发布校验文件格式错误。' }
    $BridgeExpectedHash = $Matches[1]
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $BridgeExpectedHash) { throw '安装包校验失败，未执行更新。' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $BridgeRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $BridgeArchive = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($BridgeEntry in $BridgeArchive.Entries) {
            $BridgeName = $BridgeEntry.FullName.Replace('/', '\')
            if ($BridgeName.Contains(':') -or [IO.Path]::IsPathRooted($BridgeName) -or
                (($BridgeEntry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw '安装包包含不支持的路径。' }
            $BridgeTarget = [IO.Path]::GetFullPath((Join-Path $Destination $BridgeName))
            if (-not $BridgeTarget.StartsWith($BridgeRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '安装包路径超出目标目录。' }
        }
    } finally { $BridgeArchive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
    $BridgePackages = @(@($Destination, (Join-Path $Destination 'dsh-claude-bridge')) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'package.json') -PathType Leaf })
    if ($BridgePackages.Count -ne 1) { throw '安装包目录结构错误。' }
    $BridgeManifest = Get-Content -LiteralPath (Join-Path $BridgePackages[0] 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($BridgeManifest.name -ne 'dsh-claude-bridge' -or $BridgeManifest.version -ne $ExpectedVersion) { throw '安装包版本与发布信息不一致。' }
    foreach ($BridgeFile in @('scripts\start-update.ps1', 'scripts\update-plugin.ps1', 'scripts\resolve-dsh-executable.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $BridgePackages[0] $BridgeFile) -PathType Leaf)) { throw '安装包缺少更新文件。' }
    }
    return $BridgePackages[0]
}

$BridgeTemporary = $null
$BridgeOldTls = [Net.ServicePointManager]::SecurityProtocol
try {
    [Net.ServicePointManager]::SecurityProtocol = $BridgeOldTls -bor [Net.SecurityProtocolType]::Tls12
    if ($Version -ne 'latest' -and $Version -notmatch '^v?\d+\.\d+\.\d+$') { throw '版本格式应为 latest 或 0.2.1 这样的正式版本号。' }
    if (-not $DshHome) { $DshHome = $env:DSH_HOME }
    if (-not $DshHome) { $DshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
    $DshHome = [IO.Path]::GetFullPath($DshHome)
    if (-not (Test-Path -LiteralPath (Join-Path $DshHome ('profiles\' + $Profile + '\package.json')) -PathType Leaf)) { throw '未找到目标 DSH 配置，请用 -DshHome 或 -Profile 指定。' }
    if (-not $InstallRoot) { $InstallRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DSHClaudeBridge\clients' }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $BridgeRequest = @{ Headers = @{ 'User-Agent' = 'DSH-Claude-Bridge-Updater' }; UseBasicParsing = $true; TimeoutSec = 60 }
    if ($Proxy) { $BridgeRequest.Proxy = $Proxy }
    $BridgeReleasePath = if ($Version -eq 'latest') { 'latest' } else { 'tags/v' + $Version.TrimStart('v') }
    Write-Host '正在查询正式版本。'
    $BridgeRelease = Invoke-RestMethod -Uri ('https://api.github.com/repos/yyjsjsjx-png/dsh-claude-bridge/releases/' + $BridgeReleasePath) @BridgeRequest
    $BridgeAssets = Get-BridgeReleaseAssets $BridgeRelease
    $BridgeInstalledManifest = Join-Path $DshHome ('profiles\' + $Profile + '\node_modules\dsh-claude-bridge\package.json')
    if (Test-Path -LiteralPath $BridgeInstalledManifest -PathType Leaf) {
        $BridgeInstalled = Get-Content -LiteralPath $BridgeInstalledManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($BridgeInstalled.version -eq $BridgeAssets.Version) { Write-Host ('当前已是 ' + $BridgeAssets.Version + '，无需更新。'); return }
    }
    $null = New-Item -ItemType Directory -Path $InstallRoot -Force
    $BridgeTemporary = Join-Path $InstallRoot ('.download-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $BridgeTemporary
    $BridgeZip = Join-Path $BridgeTemporary 'package.zip'
    $BridgeHash = Join-Path $BridgeTemporary 'package.sha256'
    Write-Host ('正在下载并校验 ' + $BridgeAssets.Version + '。')
    Invoke-WebRequest -Uri $BridgeAssets.Zip -OutFile $BridgeZip @BridgeRequest
    Invoke-WebRequest -Uri $BridgeAssets.Hash -OutFile $BridgeHash @BridgeRequest
    $BridgePackage = Expand-BridgeVerifiedPackage $BridgeZip $BridgeHash (Join-Path $BridgeTemporary 'extracted') $BridgeAssets.Version
    $BridgeFinal = Join-Path $InstallRoot ('v' + $BridgeAssets.Version + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    $BridgeRootPrefix = $InstallRoot + '\'
    foreach ($BridgeMovePath in @($BridgePackage,$BridgeFinal)) {
        if (-not ([IO.Path]::GetFullPath($BridgeMovePath)).StartsWith($BridgeRootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw '更新目录校验失败。' }
    }
    Move-Item -LiteralPath $BridgePackage -Destination $BridgeFinal
    $BridgeParameters = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $BridgeFinal 'scripts\start-update.ps1'),
        '-DshHome',$DshHome,'-Profile',$Profile,'-PackageDirectory',$BridgeFinal,'-NoPause')
    if ($DshExecutable) { $BridgeParameters += @('-DshExecutable',$DshExecutable) }
    $BridgePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $BridgePowerShell @BridgeParameters
    if ($LASTEXITCODE -ne 0) { throw ('更新未完成。已下载的文件保留在：' + $BridgeFinal) }
    Write-Host ('更新完成。请保留插件目录：' + $BridgeFinal) -ForegroundColor Green
    Write-Host '现在可以启动 DSH。'
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $BridgeOldTls
    if ($BridgeTemporary -and (Test-Path -LiteralPath $BridgeTemporary)) {
        $BridgeCleanup = [IO.Path]::GetFullPath($BridgeTemporary)
        if ($BridgeCleanup.StartsWith($InstallRoot + '\',[StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $BridgeCleanup) -match '^\.download-[a-f0-9]{32}$' -and
            -not ((Get-Item -LiteralPath $BridgeCleanup).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $BridgeCleanup -Recurse -Force
        }
    }
}
