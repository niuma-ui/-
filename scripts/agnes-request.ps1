$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::Expect100Continue = $false

$requestBody = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)
if (-not $requestBody) { throw 'Missing model request body.' }
if (-not $env:AGNES_REQUEST_URL) { throw 'Missing model request URL.' }
if (-not $env:KNOWLEDGE_API_KEY) { throw 'Missing model API key.' }

$timeoutSeconds = 90
if ($env:AGNES_REQUEST_TIMEOUT) { $timeoutSeconds = [int]$env:AGNES_REQUEST_TIMEOUT }
$responseText = ''
Add-Type -AssemblyName System.Net.Http
for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
  $client = $null
  $content = $null
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $env:KNOWLEDGE_API_KEY)
    $content = [System.Net.Http.StringContent]::new($requestBody, [System.Text.Encoding]::UTF8, 'application/json')
    $response = $client.PostAsync($env:AGNES_REQUEST_URL, $content).GetAwaiter().GetResult()
    $responseBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $responseText = [System.Text.Encoding]::UTF8.GetString($responseBytes)
    if (-not $response.IsSuccessStatusCode) {
      throw "Model service returned HTTP $([int]$response.StatusCode): $responseText"
    }
    break
  } catch {
    if ($attempt -ge 1) { throw }
    Start-Sleep -Milliseconds 400
  } finally {
    if ($content) { $content.Dispose() }
    if ($client) { $client.Dispose() }
  }
}

[Console]::Out.Write($responseText)
