$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $projectPath 'extension'
$distPath = Join-Path $projectPath 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $extensionPath 'manifest.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $distPath -Force | Out-Null
$archivePath = Join-Path $distPath ('XA-Extension-Observation-' + $manifest.version + '.zip')
$stagePath = Join-Path $distPath ('stage-' + [Guid]::NewGuid().ToString('N'))
$stageNative = Join-Path $stagePath 'native'
New-Item -ItemType Directory -Path $stageNative -Force | Out-Null
Copy-Item -LiteralPath $extensionPath -Destination (Join-Path $stagePath 'extension') -Recurse
Copy-Item -LiteralPath (Join-Path $projectPath 'README.md') -Destination $stagePath
foreach ($sourceName in @('host.mjs','log-reader.mjs','Register-Host.ps1','Start-BraveLogging.ps1','Unregister-Host.ps1')) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $projectPath 'native') $sourceName) -Destination $stageNative
}
Compress-Archive -LiteralPath (Join-Path $stagePath 'extension'),$stageNative,(Join-Path $stagePath 'README.md') -DestinationPath $archivePath -Force
# Validate the absolute cleanup target stays in this project's generated output.
$resolvedStage = [IO.Path]::GetFullPath($stagePath)
$resolvedDist = [IO.Path]::GetFullPath($distPath).TrimEnd('\') + '\'
if (-not $resolvedStage.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected package staging path; refusing cleanup.' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
Get-Item -LiteralPath $archivePath | Select-Object FullName,Length
