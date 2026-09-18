param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateSet('sftp', 'ftp', 's3')][string]$Protocol,
    [string]$AssemblyPath = 'C:\Program Files (x86)\WinSCP\WinSCPnet.dll'
)

$ErrorActionPreference = 'Stop'
Add-Type -Path $AssemblyPath
$sourceFile = Get-Item -LiteralPath $SourcePath
$session = New-Object WinSCP.Session
$session.ExecutablePath = Join-Path (Split-Path -Parent $AssemblyPath) 'WinSCP.exe'
$session.SessionLogPath = Join-Path (Split-Path -Parent $OutputDirectory) ('winscp-benchmark-' + $Protocol + '.log')
$options = New-Object WinSCP.SessionOptions
$options.HostName = '127.0.0.1'
$options.UserName = 'fixture'
$remoteName = 'openscp-benchmark-' + [Guid]::NewGuid().ToString('N') + '.bin'
$downloadPath = Join-Path $OutputDirectory ('winscp-' + $Protocol + '-' + $remoteName)
$remotePath = $null
$opened = $false
function Get-BenchmarkHash([string]$Path) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)) }
    finally { $stream.Dispose(); $hash.Dispose() }
}
try {
    switch ($Protocol) {
        'sftp' {
            $options.Protocol = [WinSCP.Protocol]::Sftp
            $options.PortNumber = 22222
            $options.Password = 'fixture-password-only'
            # Ключ считывается только с локального одноразового тестового сервера.
            $options.SshHostKeyFingerprint = $session.ScanFingerprint($options, 'SHA-256')
            $remotePath = '/home/fixture/data/' + $remoteName
        }
        'ftp' {
            $options.Protocol = [WinSCP.Protocol]::Ftp
            $options.FtpMode = [WinSCP.FtpMode]::Passive
            # PASV возвращает адрес контейнера; используем опубликованный адрес сервера.
            $options.AddRawSettings('FtpForcePasvIp2', 'on')
            $options.PortNumber = 21210
            $options.Password = 'fixture-ftp-password-only'
            $remotePath = '/data/' + $remoteName
        }
        's3' {
            $options.Protocol = [WinSCP.Protocol]::S3
            $options.PortNumber = 29000
            $options.UserName = 'fixture-access-only'
            $options.Password = 'fixture-secret-only-not-production'
            $options.Secure = $false
            $options.AddRawSettings('S3DefaultRegion', 'us-east-1')
            $options.AddRawSettings('S3UrlStyle', '1')
            $remotePath = '/fixture-bucket/' + $remoteName
        }
    }
    $session.Open($options)
    $opened = $true
    $transferOptions = New-Object WinSCP.TransferOptions
    $transferOptions.TransferMode = [WinSCP.TransferMode]::Binary
    $transferOptions.PreserveTimestamp = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $session.PutFiles($sourceFile.FullName, $remotePath, $false, $transferOptions).Check()
    $uploadSeconds = $timer.Elapsed.TotalSeconds
    $timer.Restart()
    $session.GetFiles($remotePath, $downloadPath, $false, $transferOptions).Check()
    $downloadSeconds = $timer.Elapsed.TotalSeconds
    $expectedHash = Get-BenchmarkHash $sourceFile.FullName
    $actualHash = Get-BenchmarkHash $downloadPath
    if ($expectedHash -ne $actualHash) { throw 'SHA-256 mismatch after WinSCP round trip.' }
    [ordered]@{
        client = 'WinSCP'
        version = (Get-Item -LiteralPath $session.ExecutablePath).VersionInfo.ProductVersion
        protocol = $Protocol
        sizeMiB = $sourceFile.Length / 1MB
        uploadSeconds = [Math]::Round($uploadSeconds, 3)
        uploadMiBPerSecond = [Math]::Round($sourceFile.Length / 1MB / $uploadSeconds, 2)
        downloadSeconds = [Math]::Round($downloadSeconds, 3)
        downloadMiBPerSecond = [Math]::Round($sourceFile.Length / 1MB / $downloadSeconds, 2)
        sha256Verified = $true
    } | ConvertTo-Json -Compress
} finally {
    if ($opened -and $remotePath) { $session.RemoveFiles($remotePath).Check() }
    $session.Dispose()
    if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath }
}
