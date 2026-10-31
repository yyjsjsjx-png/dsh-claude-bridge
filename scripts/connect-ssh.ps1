param([string]$ConfigPath = (Join-Path $PSScriptRoot 'ssh.json'))
$ErrorActionPreference = 'Stop'
$testConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($testConfig.host -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$' -or
    $testConfig.user -notmatch '^[a-z_][a-z0-9_-]{0,31}$' -or
    $testConfig.port -lt 1 -or $testConfig.port -gt 65535 -or
    $testConfig.localPort -lt 1 -or $testConfig.localPort -gt 65535 -or
    $testConfig.remotePort -lt 1 -or $testConfig.remotePort -gt 65535) { throw 'SSH 配置无效。' }
$sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $sshCommand) { throw '未找到 Windows OpenSSH 客户端。请在系统可选功能中启用 OpenSSH 客户端后重试。' }
$identityPath = Join-Path $PSScriptRoot 'id_ed25519'
$knownHostsPath = Join-Path $PSScriptRoot 'known_hosts'
if (-not (Test-Path -LiteralPath $identityPath) -or -not (Test-Path -LiteralPath $knownHostsPath)) { throw '缺少测试私钥或服务器公钥文件。' }
$testIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $identityPath /inheritance:r /grant:r "${testIdentity}:(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法限制测试私钥权限。' }
$probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, [int]$testConfig.localPort)
try { $probe.Start() } catch { throw "本机 $($testConfig.localPort) 端口已占用。请先关闭此前的测试转发窗口。" } finally { $probe.Stop() }
$sshArguments = @('-F', 'none', '-N', '-T', '-p', [string]$testConfig.port,
    '-i', $identityPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHostsPath", '-o', 'UpdateHostKeys=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10', '-L', "127.0.0.1:$($testConfig.localPort):127.0.0.1:$($testConfig.remotePort)",
    "$($testConfig.user)@$($testConfig.host)")
Write-Host "正在建立加密连接；DSH 服务器地址填 ws://127.0.0.1:$($testConfig.localPort)/"
Write-Host '请保持此窗口打开。短暂断线会自动重连，关闭窗口可停止。'
$retrySeconds = 1
while ($true) {
    $beganAt = [DateTime]::UtcNow
    & $sshCommand.Source @sshArguments
    if (([DateTime]::UtcNow - $beganAt).TotalSeconds -ge 30) { $retrySeconds = 1 }
    Write-Host "连接已断开，${retrySeconds} 秒后重试。"
    Start-Sleep -Seconds $retrySeconds
    $retrySeconds = [Math]::Min(15, $retrySeconds * 2)
}
