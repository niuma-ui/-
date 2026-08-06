param(
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$servicePort = '4174'
$serviceUrl = "http://127.0.0.1:$servicePort"
$addressFile = Join-Path $projectRoot 'public-url.txt'
$logFile = Join-Path $env:TEMP 'design-standard-cloudflared.log'
$bundledNode = Join-Path $projectRoot 'tools\node.exe'
$bundledCloudflared = Join-Path $projectRoot 'tools\cloudflared.exe'
$nodeCommand = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }
$cloudflaredCommand = if (Test-Path $bundledCloudflared) { $bundledCloudflared } else { (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }
$serverProcess = $null
$tunnelProcess = $null

if (-not $cloudflaredCommand) {
  throw 'cloudflared was not found.'
}

foreach ($name in @('KNOWLEDGE_API_KEY', 'KNOWLEDGE_API_BASE', 'KNOWLEDGE_MODEL')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($value) { Set-Item -Path "Env:$name" -Value $value }
}
$env:KNOWLEDGE_MODEL = 'agnes-2.5-flash'

function Get-ReadyStatus {
  try { return Invoke-RestMethod -Uri "$serviceUrl/api/knowledge/status" -TimeoutSec 3 } catch { return $null }
}

function Test-PublicAddress([string]$Url) {
  if (-not $Url) { return $false }
  try {
    $status = Invoke-RestMethod -Uri "$Url/api/knowledge/status" -TimeoutSec 8
    return [bool]$status.ready
  } catch {
    return $false
  }
}

try {
  $status = Get-ReadyStatus
  if (-not $status.ready) {
    $previousPort = $env:PORT
    $env:PORT = $servicePort
    $serverProcess = Start-Process -FilePath $nodeCommand -ArgumentList 'server.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $previousPort }
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
      Start-Sleep -Seconds 1
      if ($serverProcess.HasExited) { throw 'The knowledge service failed to start.' }
      $status = Get-ReadyStatus
      if ($status.ready) { break }
    }
  }
  if (-not $status.ready) { throw 'The PDF full-text index is not ready.' }

  $savedUrl = if (Test-Path $addressFile) { (Get-Content -Raw $addressFile).Trim() } else { '' }
  if (Test-PublicAddress $savedUrl) {
    Write-Host "Knowledge base is already available at: $savedUrl" -ForegroundColor Green
    if (-not $Background) { Start-Process $savedUrl }
    return
  }

  Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
  $tunnelProcess = Start-Process -FilePath $cloudflaredCommand `
    -ArgumentList @('tunnel', '--url', $serviceUrl, '--protocol', 'http2', '--no-autoupdate') `
    -RedirectStandardError $logFile -WindowStyle Hidden -PassThru

  $publicUrl = ''
  for ($attempt = 0; $attempt -lt 45; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ($tunnelProcess.HasExited) { break }
    if (Test-Path $logFile) {
      $match = [regex]::Match((Get-Content -Raw $logFile), 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($match.Success) {
        $publicUrl = $match.Value
        break
      }
    }
  }
  if (-not $publicUrl) { throw 'Unable to create the remote tunnel. Check the network and retry.' }

  Set-Content -LiteralPath $addressFile -Value $publicUrl -Encoding utf8
  if (-not (Test-PublicAddress $publicUrl)) { throw 'The remote address was created but is not reachable yet.' }

  Write-Host ''
  Write-Host 'Remote knowledge base is ready:' -ForegroundColor Green
  Write-Host $publicUrl -ForegroundColor Cyan
  Write-Host 'The address is saved in public-url.txt. Keep this window open while sharing.'
  Start-Process $publicUrl

  if ($Background) {
    while (-not $tunnelProcess.HasExited) { Start-Sleep -Seconds 10 }
  } else {
    Read-Host 'Press Enter to stop remote sharing'
  }
} finally {
  if ($tunnelProcess -and -not $tunnelProcess.HasExited) { Stop-Process -Id $tunnelProcess.Id -Force }
  if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
}
