[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$Root = (Get-Location).Path,

  [Parameter(Mandatory = $false)]
  [string]$OutputPath,

  [Parameter(Mandatory = $false)]
  [int]$MaxOutputMB = 512,

  [Parameter(Mandatory = $false)]
  [int]$MaxFileMB = 2
)

$ErrorActionPreference = 'Stop'

if (-not $OutputPath -or $OutputPath.Trim() -eq '') {
  $OutputPath = Join-Path $Root 'codebase_dump_optimized.txt'
}

$maxOutputBytes = [int64]$MaxOutputMB * 1024 * 1024
$maxFileBytes = [int64]$MaxFileMB * 1024 * 1024

$excludedDirNames = @('node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache')
$excludedDirRegex = '(\\|/)(node_modules|\.git|dist|build|\.next|\.turbo|\.cache)(\\|/|$)'

$binaryExtensions = @(
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.bz2', '.tar',
  '.exe', '.dll', '.pdb', '.so', '.dylib', '.bin', '.dat', '.wasm',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mov', '.mp3', '.wav',
  '.sqlite', '.db'
)

$secretPathRegex = '(?i)(^|\\|/)\.env(\\|/|\.|$)|\.(pem|key|pfx|p12|crt|cer)$'
$excludeDumpRegex = '(?i)(^|\\|/)(codebase_dump.*\.txt|CODEBASE_DUMP_FULL\.txt)$'

function Get-RelativePath([string]$basePath, [string]$fullPath) {
  $base = (Resolve-Path -LiteralPath $basePath).Path.TrimEnd('\', '/')
  $full = (Resolve-Path -LiteralPath $fullPath).Path
  if ($full.Length -le $base.Length) {
    return $full
  }

  $rel = $full.Substring($base.Length)
  return $rel.TrimStart('\', '/')
}

function Should-ExcludeFile([string]$fullPath) {
  if ($fullPath -match $excludedDirRegex) { return $true }
  if ($fullPath -match $secretPathRegex) { return $true }
  if ((Get-RelativePath $Root $fullPath) -match $excludeDumpRegex) { return $true }
  return $false
}

function Is-BinaryFile([System.IO.FileInfo]$fileInfo) {
  $ext = $fileInfo.Extension.ToLowerInvariant()
  if ($binaryExtensions -contains $ext) { return $true }

  try {
    $bytes = Get-Content -LiteralPath $fileInfo.FullName -Encoding Byte -TotalCount 8192
    if ($null -eq $bytes -or $bytes.Count -eq 0) { return $false }
    foreach ($b in $bytes) {
      if ($b -eq 0) { return $true }
    }
  } catch {
    return $true
  }

  return $false
}

function Append-Utf8([string]$path, [string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  [System.IO.File]::AppendAllText($path, $text, [System.Text.Encoding]::UTF8)
  return $bytes.Length
}

$rootResolved = (Resolve-Path -LiteralPath $Root).Path

if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

$currentBytes = 0
$skippedLarge = New-Object System.Collections.Generic.List[object]
$skippedBinary = New-Object System.Collections.Generic.List[object]
$skippedBudget = New-Object System.Collections.Generic.List[object]
$skippedSecrets = New-Object System.Collections.Generic.List[object]
$includedFiles = 0
$consideredFiles = 0
$excludedDirFiles = 0

$header = @()
$header += "# Optimized codebase dump"
$header += "# Generated: $([DateTime]::UtcNow.ToString('u')) (UTC)"
$header += "# Root: $rootResolved"
$header += "# Output: $OutputPath"
$header += "# Excluded directories: $($excludedDirNames -join ', ')"
$header += "# Excluded secrets: .env*, *.pem, *.key, *.pfx, *.p12, *.crt, *.cer"
$header += "# Max output size: ${MaxOutputMB}MB"
$header += "# Max included file size: ${MaxFileMB}MB (larger files are listed but not embedded)"
$header += ""

$currentBytes += Append-Utf8 $OutputPath (($header -join "`r`n") + "`r`n")

# Lightweight directory tree (depth <= 4)
$treeLines = New-Object System.Collections.Generic.List[string]
$treeLines.Add('===== DIRECTORY TREE (depth<=4, excludes applied) =====')

Get-ChildItem -LiteralPath $rootResolved -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $p = $_.FullName
    if ($p -match $excludedDirRegex) { return $false }
    $rel = Get-RelativePath $rootResolved $p
    if (-not $rel) { return $false }
    $depth = ($rel -split '[\\/]').Count
    return $depth -le 4
  } |
  ForEach-Object {
    $treeLines.Add((Get-RelativePath $rootResolved $_.FullName))
  }

$treeLines.Add('')
$currentBytes += Append-Utf8 $OutputPath (($treeLines -join "`r`n") + "`r`n")

Write-Host "Enumerating files under $rootResolved ..."

$files = Get-ChildItem -LiteralPath $rootResolved -File -Recurse -Force -ErrorAction SilentlyContinue

foreach ($f in $files) {
  $consideredFiles++

  $full = $f.FullName
  $rel = Get-RelativePath $rootResolved $full

  if ($full -match $excludedDirRegex) {
    $excludedDirFiles++
    continue
  }

  if ($full -match $secretPathRegex) {
    $skippedSecrets.Add([pscustomobject]@{ path = $rel; bytes = $f.Length; reason = 'secret_or_env' })
    continue
  }

  if ($rel -match $excludeDumpRegex) {
    continue
  }

  if ($f.Length -gt $maxFileBytes) {
    $skippedLarge.Add([pscustomobject]@{ path = $rel; bytes = $f.Length; reason = 'file_too_large' })
    continue
  }

  if (Is-BinaryFile $f) {
    $skippedBinary.Add([pscustomobject]@{ path = $rel; bytes = $f.Length; reason = 'binary' })
    continue
  }

  $content = ''
  try {
    # Avoid PowerShell 5.1 default codepage issues (which can corrupt UTF-8 text).
    # .NET will auto-detect BOMs and otherwise assumes UTF-8.
    $content = [System.IO.File]::ReadAllText($full)
  } catch {
    $skippedBinary.Add([pscustomobject]@{ path = $rel; bytes = $f.Length; reason = 'unreadable_as_text' })
    continue
  }

  $entryHeader = "===== FILE: $rel =====`r`n"
  $entryFooter = "`r`n===== END FILE: $rel =====`r`n`r`n"

  $estimatedBytes = [System.Text.Encoding]::UTF8.GetByteCount($entryHeader) +
    [System.Text.Encoding]::UTF8.GetByteCount($content) +
    [System.Text.Encoding]::UTF8.GetByteCount($entryFooter)

  if (($currentBytes + $estimatedBytes) -gt $maxOutputBytes) {
    $skippedBudget.Add([pscustomobject]@{ path = $rel; bytes = $f.Length; reason = 'output_budget_exceeded' })
    continue
  }

  $currentBytes += Append-Utf8 $OutputPath $entryHeader
  $currentBytes += Append-Utf8 $OutputPath $content
  $currentBytes += Append-Utf8 $OutputPath $entryFooter
  $includedFiles++
}

$summary = New-Object System.Collections.Generic.List[string]
$summary.Add('===== SUMMARY =====')
$summary.Add("Files considered: $consideredFiles")
$summary.Add("Files excluded by dir rules: $excludedDirFiles")
$summary.Add("Files embedded: $includedFiles")
$summary.Add("Skipped (binary): $($skippedBinary.Count)")
$summary.Add("Skipped (too large): $($skippedLarge.Count)")
$summary.Add("Skipped (secrets): $($skippedSecrets.Count)")
$summary.Add("Skipped (output budget): $($skippedBudget.Count)")
$summary.Add("Output bytes (approx): $currentBytes")
$summary.Add('')

$summary.Add('===== SKIPPED BINARIES / UNREADABLE TEXT =====')
foreach ($row in $skippedBinary) { $summary.Add("$($row.path) ($($row.bytes) bytes) [$($row.reason)]") }
$summary.Add('')

$summary.Add('===== SKIPPED LARGE FILES (not embedded) =====')
foreach ($row in $skippedLarge) { $summary.Add("$($row.path) ($($row.bytes) bytes) [$($row.reason)]") }
$summary.Add('')

$summary.Add('===== SKIPPED SECRETS / ENV FILES (not embedded) =====')
foreach ($row in $skippedSecrets) { $summary.Add("$($row.path) ($($row.bytes) bytes) [$($row.reason)]") }
$summary.Add('')

$summary.Add('===== SKIPPED DUE TO OUTPUT SIZE BUDGET (not embedded) =====')
foreach ($row in $skippedBudget) { $summary.Add("$($row.path) ($($row.bytes) bytes) [$($row.reason)]") }
$summary.Add('')

$currentBytes += Append-Utf8 $OutputPath (($summary -join "`r`n") + "`r`n")

$final = Get-Item -LiteralPath $OutputPath
Write-Host "Wrote: $($final.FullName)"
Write-Host "Size:  $($final.Length) bytes"
