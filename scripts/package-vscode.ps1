param([string]$Destination)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'vscode'
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $Destination) { $Destination = Join-Path $projectRoot "artifacts\pi-pair-$($manifest.version).vsix" }
$Destination = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Destination)) -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$escapedName = [Security.SecurityElement]::Escape($manifest.displayName)
$escapedDescription = [Security.SecurityElement]::Escape($manifest.description)
$vsixManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($manifest.name)" Version="$($manifest.version)" Publisher="$($manifest.publisher)" />
    <DisplayName>$escapedName</DisplayName><Description xml:space="preserve">$escapedDescription</Description>
    <Tags>pi,pair,review</Tags><Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($manifest.engines.vscode)" /><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" /><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" /><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" /></Assets>
</PackageManifest>
"@
$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json" /><Default Extension="cjs" ContentType="application/javascript" /><Default Extension="md" ContentType="text/markdown" /><Default Extension="svg" ContentType="image/svg+xml" /><Default Extension="vsixmanifest" ContentType="text/xml" /></Types>
'@
# A small dependency-free local VSIX; never includes tests, tokens, or node_modules.
$stream = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in @(@('extension.vsixmanifest', $vsixManifest), @('[Content_Types].xml', $contentTypes))) {
    $entry = $archive.CreateEntry($item[0])
    $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write($item[1]) } finally { $writer.Dispose() }
  }
  foreach ($file in @('package.json', 'extension.cjs', 'client.cjs', 'command-view.cjs', 'checkpoint-panel.cjs', 'feedback-model.cjs', 'feedback-ui.cjs', 'feedback-controller.cjs', 'README.md', 'media/pair.svg')) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $extensionRoot $file), "extension/$file") | Out-Null
  }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Output $Destination
