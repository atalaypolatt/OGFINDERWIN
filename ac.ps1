$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://127.0.0.1:4317'
function Test-Up {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; return ($r.StatusCode -eq 200) }
  catch { return $false }
}
function Show-Error([string]$message) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($message, 'Pair Arama') | Out-Null
}
function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
if (-not (Test-Up)) {
  $node = Find-Node
  if (-not $node) { Show-Error 'Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu yukleyin.'; exit 1 }
  try {
    Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'server.log') -RedirectStandardError (Join-Path $root 'server.err.log') | Out-Null
  } catch { Show-Error "Sunucu baslatilamadi: $($_.Exception.Message)"; exit 1 }
  $up = $false
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 400; if (Test-Up) { $up = $true; break } }
  if (-not $up) {
    $logFile = Join-Path $root 'server.err.log'
    $detail = if (Test-Path $logFile) { (Get-Content $logFile -Tail 10) -join "`n" } else { '' }
    Show-Error "Sunucu acilamadi. $detail`nHata kaydi: $logFile"
    exit 1
  }
}
$chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) { Start-Process -FilePath $chrome -ArgumentList "--app=$url" }
else { Start-Process $url }
