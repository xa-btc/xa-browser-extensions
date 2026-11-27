param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [ValidatePattern('^com\.xa\.extension_observatory(?:\.test_[a-z0-9]+)?$')][string]$HostName = 'com.xa.extension_observatory'
)
$ErrorActionPreference = 'Stop'
$hostName = $HostName
$hostManifestPath = Join-Path $PSScriptRoot 'host.manifest.json'
$configPath = Join-Path $PSScriptRoot 'host.config.json'
$launcherPath = Join-Path $PSScriptRoot 'launch-host.cmd'
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
if ($NodePath -match '[%"!\r\n]') { throw 'Node path contains characters unsupported by the native launcher.' }
$version = & $NodePath --version
$nodeVersion = [Version]$version.TrimStart('v')
if ($nodeVersion -lt [Version]'20.11.0') { throw 'Node.js 20.11 or newer is required for the optional local companion.' }
$registryPaths = @(
    ('HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $hostName),
    ('HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\' + $hostName)
)
foreach ($registryPath in $registryPaths) {
    if (Test-Path -LiteralPath $registryPath) {
        $existing = (Get-Item -LiteralPath $registryPath).GetValue('')
        if ($existing -and $existing -ne $hostManifestPath) { throw "A companion is already registered elsewhere: $existing. Unregister that installation first." }
    }
}
$config = @{ extensionId = $ExtensionId; logPath = '' }
if (Test-Path -LiteralPath $configPath) {
    $previous = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $config.logPath = $previous.logPath
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
@{
    name = $hostName
    description = 'Read-only local Brave diagnostic activity log collector'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
} | ConvertTo-Json | Set-Content -LiteralPath $hostManifestPath -Encoding UTF8
$launcher = "@echo off`r`nchcp 65001 >nul`r`n`"$NodePath`" --no-warnings `"%~dp0host.mjs`" %*`r`n"
[IO.File]::WriteAllText($launcherPath, $launcher, (New-Object Text.UTF8Encoding($false)))
foreach ($registryPath in $registryPaths) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $hostManifestPath
    if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $hostManifestPath) { throw "Registration verification failed: $registryPath" }
}
Write-Host 'Registered the local companion for this extension ID. No browser settings or extensions were changed.'
Write-Host 'Next: exit Brave fully, run native\Start-BraveLogging.ps1, and click Connect runtime log in Observatory.'
