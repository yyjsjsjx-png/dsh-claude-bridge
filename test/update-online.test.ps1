$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$BridgeOnlineScript = Join-Path (Split-Path $PSScriptRoot) 'scripts\update-online.ps1'
$BridgeTokens = $null; $BridgeErrors = $null
$BridgeAst = [Management.Automation.Language.Parser]::ParseFile($BridgeOnlineScript,[ref]$BridgeTokens,[ref]$BridgeErrors)
if ($BridgeErrors.Count) { throw '在线更新脚本语法检查失败' }
$BridgeDownloadedText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($BridgeOnlineScript))
$null = [scriptblock]::Create($BridgeDownloadedText.TrimStart([char]0xFEFF))
foreach ($BridgeFunction in $BridgeAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
    . ([scriptblock]::Create($BridgeFunction.Extent.Text))
}
function Assert-Online([bool]$Condition) { if (-not $Condition) { throw '在线更新检查失败' } }
$BridgeFixture = Join-Path ([IO.Path]::GetTempPath()) ('dsh-online-' + [Guid]::NewGuid().ToString('N'))
try {
    $null = New-Item -ItemType Directory -Path $BridgeFixture
    $BridgeBase = 'https://github.com/yyjsjsjx-png/dsh-claude-bridge/releases/download/v0.2.1/'
    $BridgeRelease = [PSCustomObject]@{tag_name='v0.2.1';draft=$false;prerelease=$false;assets=@(
        [PSCustomObject]@{name='dsh-claude-bridge-0.2.1.zip';browser_download_url=($BridgeBase+'dsh-claude-bridge-0.2.1.zip')},
        [PSCustomObject]@{name='dsh-claude-bridge-0.2.1.sha256';browser_download_url=($BridgeBase+'dsh-claude-bridge-0.2.1.sha256')})}
    Assert-Online ((Get-BridgeReleaseAssets $BridgeRelease).Version -eq '0.2.1')
    $BridgeRelease.assets[0].browser_download_url='https://example.invalid/package.zip'
    $BridgeRejected=$false; try { Get-BridgeReleaseAssets $BridgeRelease | Out-Null } catch { $BridgeRejected=$true }; Assert-Online $BridgeRejected
    $BridgeSource=Join-Path $BridgeFixture 'source'
    $null=New-Item -ItemType Directory -Path (Join-Path $BridgeSource 'scripts')
    [IO.File]::WriteAllText((Join-Path $BridgeSource 'package.json'),'{"name":"dsh-claude-bridge","version":"0.2.1"}')
    foreach($BridgeName in @('start-update.ps1','update-plugin.ps1','resolve-dsh-executable.ps1')){[IO.File]::WriteAllText((Join-Path $BridgeSource ('scripts\'+$BridgeName)),'# fixture')}
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $BridgeZip=Join-Path $BridgeFixture 'good.zip';$BridgeHash=Join-Path $BridgeFixture 'hash.txt'
    [IO.Compression.ZipFile]::CreateFromDirectory($BridgeSource,$BridgeZip)
    $BridgeDigest=(Get-FileHash -LiteralPath $BridgeZip -Algorithm SHA256).Hash
    [IO.File]::WriteAllText($BridgeHash,($BridgeDigest+'  dsh-claude-bridge-0.2.1.zip'))
    $BridgeExpanded=Expand-BridgeVerifiedPackage $BridgeZip $BridgeHash (Join-Path $BridgeFixture 'ok') '0.2.1'
    Assert-Online (Test-Path -LiteralPath (Join-Path $BridgeExpanded 'scripts\start-update.ps1'))
    [IO.File]::WriteAllText($BridgeHash,('0'*64+'  dsh-claude-bridge-0.2.1.zip'))
    $BridgeRejected=$false;try{Expand-BridgeVerifiedPackage $BridgeZip $BridgeHash (Join-Path $BridgeFixture 'bad') '0.2.1'|Out-Null}catch{$BridgeRejected=$true};Assert-Online $BridgeRejected
    $BridgeEvil=Join-Path $BridgeFixture 'traversal.zip'
    $BridgeArchive=[IO.Compression.ZipFile]::Open($BridgeEvil,[IO.Compression.ZipArchiveMode]::Create)
    try{$null=$BridgeArchive.CreateEntry('../outside.txt')}finally{$BridgeArchive.Dispose()}
    [IO.File]::WriteAllText($BridgeHash,((Get-FileHash -LiteralPath $BridgeEvil -Algorithm SHA256).Hash+'  dsh-claude-bridge-0.2.1.zip'))
    $BridgeRejected=$false;try{Expand-BridgeVerifiedPackage $BridgeEvil $BridgeHash (Join-Path $BridgeFixture 'escape') '0.2.1'|Out-Null}catch{$BridgeRejected=$true};Assert-Online $BridgeRejected
    Assert-Online (-not (Test-Path -LiteralPath (Join-Path $BridgeFixture 'outside.txt')))
    Write-Output '在线更新5/5通过：正式附件、地址拒绝、校验解压、错误摘要拒绝、越界路径拒绝。'
}finally{
    $BridgeResolved=[IO.Path]::GetFullPath($BridgeFixture)
    $BridgeTempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($BridgeResolved.StartsWith($BridgeTempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $BridgeResolved) -match '^dsh-online-[a-f0-9]{32}$'){
        Remove-Item -LiteralPath $BridgeResolved -Recurse -Force
    }
}
