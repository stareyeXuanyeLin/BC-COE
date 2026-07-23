$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root 'src'
$dist = Join-Path $root 'dist'
$output = Join-Path $dist 'CustomOutfitEditorEchoMirror.user.js'
$parts = @(
  '00-userscript-header.js','01-runtime.js','02-data.js','03-storage.js','04-assets.js',
  '05-capabilities.js','06-adapters.js','07-renderer.js','08-ui-shell.js','09-wardrobe.js',
  '10-editor.js','11-remote-protocol.js','12-remote-store.js','13-remote-transport.js',
  '14-remote-controller.js','15-bootstrap.js'
)
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$content = [System.Text.StringBuilder]::new()
foreach ($part in $parts) {
  $path = Join-Path $source $part
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing source file: $part" }
  [void]$content.AppendLine((Get-Content -LiteralPath $path -Raw -Encoding UTF8))
  [void]$content.AppendLine("`n")
}
[System.IO.File]::WriteAllText($output, $content.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Host "Built: $output"
