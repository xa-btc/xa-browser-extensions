param(
    [string]$BravePath = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe',
    [string]$ProfileDirectory = 'Default'
)
$ErrorActionPreference = 'Stop'
if (Get-Process -Name brave -ErrorAction SilentlyContinue) { throw 'Exit Brave fully, including background processes, then run this script again. Existing Brave processes ignore new logging flags. This script will not close them for you.' }
if ($ProfileDirectory -notmatch '^[a-zA-Z0-9 _-]+$') { throw 'Use a profile directory name such as Default or Profile 1.' }
$BravePath = (Resolve-Path -LiteralPath $BravePath).Path
$configPath = Join-Path $PSScriptRoot 'host.config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Run Register-Host.ps1 with the installed Observatory extension ID first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$logDirectory = Join-Path $PSScriptRoot 'runtime-logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory ('activity-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
$config.logPath = $logPath
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
Write-Host 'Starting Brave diagnostic activity logging. Logs can contain URLs and API arguments, and continue growing while Brave runs.'
Write-Host 'Stop diagnostic logging by exiting Brave fully and launching it normally. Observatory Pause stops collection, not browser logging.'
Write-Host "Log: $logPath"
$braveArguments = @(
    ('--profile-directory=' + $ProfileDirectory),
    '--enable-extension-activity-logging', '--enable-extension-activity-log-testing',
    '--enable-logging', '--vmodule=activity_log=1', ('--log-file=' + $logPath)
)
& $BravePath @braveArguments
