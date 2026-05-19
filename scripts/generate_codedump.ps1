[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$Root = (Get-Location).Path,

  [Parameter(Mandatory = $false)]
  [string]$OutputPath = (Join-Path (Get-Location).Path 'codedump.txt')
)

$ErrorActionPreference = 'Stop'

$rootResolved = (Resolve-Path -LiteralPath $Root).Path
if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

$excludedDirRegex = '(?i)(^|[\\/])(node_modules|\.git|\.next|dist|build|coverage)([\\/]|$)'
$secretRegex = '(?i)(^|[\\/])\.env(\.|$)'
$skipRegex = '(?i)(pipelineWorker\.log|\.log$|\.tmp$|\.temp$|\.pid$|\.tsbuildinfo$)'
$binaryExtensions = @(
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.bz2', '.tar',
  '.exe', '.dll', '.pdb', '.so', '.dylib', '.bin', '.dat', '.wasm',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mov', '.mp3', '.wav',
  '.sqlite', '.db'
)

function Test-TextFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($binaryExtensions -contains $ext) {
    return $false
  }

  if ($Path -match $skipRegex) {
    return $false
  }

  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) {
      return $true
    }

    $sampleLength = [Math]::Min($bytes.Length, 8192)
    for ($i = 0; $i -lt $sampleLength; $i++) {
      if ($bytes[$i] -eq 0) {
        return $false
      }
    }

    return $true
  } catch {
    return $false
  }
}

$allFiles = git ls-files -co --exclude-standard |
  Where-Object {
    $_ -and
    ($_ -notmatch $excludedDirRegex) -and
    ($_ -notmatch $secretRegex) -and
    ($_ -ne 'codedump.txt')
  } |
  Sort-Object

$selectedFiles = New-Object System.Collections.Generic.List[string]
$skippedFiles = New-Object System.Collections.Generic.List[string]

foreach ($rel in $allFiles) {
  $fullPath = Join-Path $rootResolved $rel
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    continue
  }

  if (Test-TextFile -Path $fullPath) {
    $selectedFiles.Add($rel)
  } else {
    $skippedFiles.Add($rel)
  }
}

$builder = New-Object System.Text.StringBuilder

[void]$builder.AppendLine('# Trajectos Code Dump')
[void]$builder.AppendLine("Generated: $([DateTime]::UtcNow.ToString('u')) UTC")
[void]$builder.AppendLine("Root: $rootResolved")
[void]$builder.AppendLine("Included text files: $($selectedFiles.Count)")
[void]$builder.AppendLine("Skipped non-text/binary/generated/secret files: $($skippedFiles.Count)")
[void]$builder.AppendLine('')

[void]$builder.AppendLine('## Index')
for ($i = 0; $i -lt $selectedFiles.Count; $i++) {
  $rel = $selectedFiles[$i]
  $number = '{0:D3}' -f ($i + 1)
  [void]$builder.AppendLine("$number. $rel")
}

[void]$builder.AppendLine('')
[void]$builder.AppendLine('## Files')

function Get-ParentDirectory([string]$relativePath) {
  $parent = Split-Path -Path $relativePath -Parent
  if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq '.') {
    return ''
  }

  return $parent.Replace('/', '\\')
}

$filesByDirectory = @{}
foreach ($entry in $selectedFiles) {
  $directory = Get-ParentDirectory $entry
  if (-not $filesByDirectory.ContainsKey($directory)) {
    $filesByDirectory[$directory] = New-Object System.Collections.Generic.List[string]
  }

  $filesByDirectory[$directory].Add($entry)
}

[void]$builder.AppendLine('## Files')
[void]$builder.AppendLine('')

$directoryOrder = @('')
$directoryOrder += ($filesByDirectory.Keys | Where-Object { $_ -ne '' } | Sort-Object)

$counter = 0
foreach ($directory in $directoryOrder) {
  $label = if ($directory -eq '') { '[root]' } else { $directory }
  [void]$builder.AppendLine("### Directory: $label")

  foreach ($entry in ($filesByDirectory[$directory] | Sort-Object)) {
    $counter++
    $number = '{0:D3}' -f $counter
    $fullPath = Join-Path $rootResolved $entry
    $content = [System.IO.File]::ReadAllText($fullPath)
    [void]$builder.AppendLine("#### $number. $entry")
    [void]$builder.AppendLine("<<< BEGIN FILE ${number}: $entry >>>")
    [void]$builder.AppendLine($content.TrimEnd("`r", "`n"))
    [void]$builder.AppendLine("<<< END FILE ${number}: $entry >>>")
    [void]$builder.AppendLine('')
  }
}
if ($skippedFiles.Count -gt 0) {
  [void]$builder.AppendLine('## Skipped files')
  foreach ($rel in $skippedFiles) {
    [void]$builder.AppendLine($rel)
  }
}

[System.IO.File]::WriteAllText($OutputPath, $builder.ToString(), [System.Text.Encoding]::UTF8)
Write-Host "Wrote $OutputPath"
Write-Host "Files included: $($selectedFiles.Count)"
Write-Host "Files skipped: $($skippedFiles.Count)"
