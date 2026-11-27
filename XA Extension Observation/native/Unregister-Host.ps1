param([ValidatePattern('^com\.xa\.extension_observatory(?:\.test_[a-z0-9]+)?$')][string]$HostName = 'com.xa.extension_observatory')
$ErrorActionPreference = 'Stop'
$hostName = $HostName
$expectedManifest = Join-Path $PSScriptRoot 'host.manifest.json'
foreach ($prefix in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts')) {
    $registryPath = Join-Path $prefix $hostName
    if (Test-Path -LiteralPath $registryPath) {
        if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $expectedManifest) { throw "Registration points to another installation; leaving it unchanged: $registryPath" }
        Remove-Item -LiteralPath $registryPath
    }
}
Write-Host 'Unregistered this companion. Logs and configuration were preserved. Launch Brave normally to stop diagnostic logging.'
