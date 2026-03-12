# .\scripts\build-extension.ps1
# powershell -ExecutionPolicy Bypass -File .\scripts\build-extension.ps1


[CmdletBinding()]
param(
  [string]$OutputDir = "release",
  [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptRoot "..")).Path
$OutputDirPath = Join-Path $RepoRoot $OutputDir
$WebMcpCliDir = Join-Path $RepoRoot "web_mcp_cli"
$ObfuscatorCliPath = Join-Path $WebMcpCliDir "node_modules\.bin\javascript-obfuscator.cmd"
$ManifestSourcePath = Join-Path $RepoRoot "manifest.json"
$ObfuscatorConfigPath = Join-Path $ScriptRoot "obfuscator.config.json"

function Write-Stage {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Message
  )
  Write-Host "[$Stage] $Message"
}

function Throw-StepError {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Message
  )
  throw "[$Stage] $Message"
}

function Assert-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Throw-StepError -Stage "preflight" -Message "Required command '$Name' was not found in PATH."
  }
}

function Invoke-ExternalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string[]]$CommandParts,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  if ($CommandParts.Count -eq 0) {
    Throw-StepError -Stage $Stage -Message "No command provided."
  }

  $commandLine = $CommandParts -join " "
  Write-Stage -Stage $Stage -Message $commandLine

  $exe = $CommandParts[0]
  $args = @()
  if ($CommandParts.Count -gt 1) {
    $args = $CommandParts[1..($CommandParts.Count - 1)]
  }

  Push-Location $WorkingDirectory
  try {
    & $exe @args
    if ($LASTEXITCODE -ne 0) {
      Throw-StepError -Stage $Stage -Message "Command failed with exit code ${LASTEXITCODE}: $commandLine"
    }
  } finally {
    Pop-Location
  }
}

function Add-MissingManifestReference {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$MissingRefs,
    [Parameter(Mandatory = $true)][string]$Context,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$OutputRoot
  )

  if ([string]::IsNullOrWhiteSpace($RelativePath)) {
    $MissingRefs.Add("$Context -> <empty path>")
    return
  }

  $fullPath = Join-Path $OutputRoot $RelativePath
  if (-not (Test-Path -LiteralPath $fullPath)) {
    $MissingRefs.Add("$Context -> $RelativePath")
  }
}

function Validate-ManifestReferences {
  param(
    [Parameter(Mandatory = $true)][string]$OutputRoot
  )

  $outputManifestPath = Join-Path $OutputRoot "manifest.json"
  if (-not (Test-Path -LiteralPath $outputManifestPath)) {
    Throw-StepError -Stage "validate" -Message "manifest.json is missing from output directory."
  }

  $manifest = Get-Content -Raw -Path $outputManifestPath | ConvertFrom-Json
  $missingRefs = [System.Collections.Generic.List[string]]::new()

  if ($null -eq $manifest.background -or [string]::IsNullOrWhiteSpace([string]$manifest.background.service_worker)) {
    $missingRefs.Add("background.service_worker -> <missing field>")
  } else {
    Add-MissingManifestReference -MissingRefs $missingRefs -Context "background.service_worker" -RelativePath ([string]$manifest.background.service_worker) -OutputRoot $OutputRoot
  }

  if ($null -eq $manifest.action -or [string]::IsNullOrWhiteSpace([string]$manifest.action.default_popup)) {
    $missingRefs.Add("action.default_popup -> <missing field>")
  } else {
    Add-MissingManifestReference -MissingRefs $missingRefs -Context "action.default_popup" -RelativePath ([string]$manifest.action.default_popup) -OutputRoot $OutputRoot
  }

  if ($null -eq $manifest.icons) {
    $missingRefs.Add("icons -> <missing field>")
  } else {
    foreach ($iconEntry in $manifest.icons.PSObject.Properties) {
      Add-MissingManifestReference -MissingRefs $missingRefs -Context ("icons." + $iconEntry.Name) -RelativePath ([string]$iconEntry.Value) -OutputRoot $OutputRoot
    }
  }

  $contentScripts = @($manifest.content_scripts)
  if ($contentScripts.Count -eq 0) {
    $missingRefs.Add("content_scripts -> <missing field>")
  } else {
    for ($i = 0; $i -lt $contentScripts.Count; $i += 1) {
      $contentScript = $contentScripts[$i]
      $jsList = @($contentScript.js)
      if ($jsList.Count -eq 0) {
        $missingRefs.Add("content_scripts[$i].js -> <missing field>")
      } else {
        for ($j = 0; $j -lt $jsList.Count; $j += 1) {
          Add-MissingManifestReference -MissingRefs $missingRefs -Context ("content_scripts[$i].js[$j]") -RelativePath ([string]$jsList[$j]) -OutputRoot $OutputRoot
        }
      }

      $cssList = @($contentScript.css)
      if ($cssList.Count -eq 0) {
        $missingRefs.Add("content_scripts[$i].css -> <missing field>")
      } else {
        for ($j = 0; $j -lt $cssList.Count; $j += 1) {
          Add-MissingManifestReference -MissingRefs $missingRefs -Context ("content_scripts[$i].css[$j]") -RelativePath ([string]$cssList[$j]) -OutputRoot $OutputRoot
        }
      }
    }
  }

  $webAccessibleResources = @($manifest.web_accessible_resources)
  if ($webAccessibleResources.Count -eq 0) {
    $missingRefs.Add("web_accessible_resources -> <missing field>")
  } else {
    for ($i = 0; $i -lt $webAccessibleResources.Count; $i += 1) {
      $resources = @($webAccessibleResources[$i].resources)
      if ($resources.Count -eq 0) {
        $missingRefs.Add("web_accessible_resources[$i].resources -> <missing field>")
      } else {
        for ($j = 0; $j -lt $resources.Count; $j += 1) {
          Add-MissingManifestReference -MissingRefs $missingRefs -Context ("web_accessible_resources[$i].resources[$j]") -RelativePath ([string]$resources[$j]) -OutputRoot $OutputRoot
        }
      }
    }
  }

  if ($missingRefs.Count -gt 0) {
    Write-Host "[validate] Missing manifest references:"
    foreach ($item in $missingRefs) {
      Write-Host "  - $item"
    }
    Throw-StepError -Stage "validate" -Message "Manifest reference validation failed. Missing count: $($missingRefs.Count)"
  }

  Write-Stage -Stage "validate" -Message "Manifest reference validation passed."
}

function Get-ObfuscationIdentifierPrefix {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$RootPath
  )

  $rootFull = (Resolve-Path -LiteralPath $RootPath).Path
  $fileFull = (Resolve-Path -LiteralPath $FilePath).Path

  $normalizedRoot = $rootFull.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $rootUri = [System.Uri]$normalizedRoot
  $fileUri = [System.Uri]$fileFull
  $relativePath = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $sanitized = [regex]::Replace($relativePath, '[^A-Za-z0-9]', '_')
  if ([string]::IsNullOrWhiteSpace($sanitized)) {
    $sanitized = "file"
  }
  if ($sanitized.Length -gt 40) {
    $sanitized = $sanitized.Substring(0, 40)
  }

  if ($sanitized -match '^[0-9]') {
    $sanitized = "f_$sanitized"
  }

  return "tm_${sanitized}_"
}

try {
  Write-Stage -Stage "preflight" -Message "Checking required commands..."
  Assert-CommandExists -Name "node"
  Assert-CommandExists -Name "pnpm"

  if (-not (Test-Path -LiteralPath $WebMcpCliDir)) {
    Throw-StepError -Stage "preflight" -Message "Directory not found: $WebMcpCliDir"
  }
  if (-not (Test-Path -LiteralPath $ManifestSourcePath)) {
    Throw-StepError -Stage "preflight" -Message "manifest.json not found at repository root."
  }
  if (-not (Test-Path -LiteralPath $ObfuscatorConfigPath)) {
    Throw-StepError -Stage "preflight" -Message "Obfuscator config not found: $ObfuscatorConfigPath"
  }

  if ($SkipInstall) {
    Write-Stage -Stage "preflight" -Message "Skipping dependency install because -SkipInstall was provided."
  } else {
    Invoke-ExternalCommand -Stage "preflight" -CommandParts @("pnpm", "--dir", "web_mcp_cli", "install", "--frozen-lockfile") -WorkingDirectory $RepoRoot
  }

  Write-Stage -Stage "build" -Message "Preparing output directory: $OutputDirPath"
  if (Test-Path -LiteralPath $OutputDirPath) {
    Remove-Item -LiteralPath $OutputDirPath -Recurse -Force
  }
  New-Item -ItemType Directory -Path $OutputDirPath -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $OutputDirPath "web_mcp_cli") -Force | Out-Null

  Write-Stage -Stage "copy" -Message "Copying manifest and static assets..."
  Copy-Item -LiteralPath $ManifestSourcePath -Destination (Join-Path $OutputDirPath "manifest.json") -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot "icons") -Destination (Join-Path $OutputDirPath "icons") -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot "src") -Destination (Join-Path $OutputDirPath "src") -Recurse -Force

  $backgroundOutFile = Join-Path $OutputDirPath "web_mcp_cli\background.bundle.js"
  Invoke-ExternalCommand -Stage "build" -CommandParts @(
    "pnpm", "--dir", "web_mcp_cli", "exec", "esbuild",
    "background.js",
    "--bundle",
    "--format=esm",
    "--platform=browser",
    "--target=chrome120",
    "--outfile=$backgroundOutFile"
  ) -WorkingDirectory $RepoRoot

  Write-Stage -Stage "obfuscate" -Message "Obfuscating JavaScript files in output directory..."
  if (-not (Test-Path -LiteralPath $ObfuscatorCliPath)) {
    Throw-StepError -Stage "obfuscate" -Message "Obfuscator CLI was not found. Expected path: $ObfuscatorCliPath"
  }

  $jsFiles = Get-ChildItem -Path $OutputDirPath -Recurse -File -Filter "*.js"
  if ($jsFiles.Count -eq 0) {
    Throw-StepError -Stage "obfuscate" -Message "No JavaScript files found in output directory."
  }

  foreach ($jsFile in $jsFiles) {
    $identifierPrefix = Get-ObfuscationIdentifierPrefix -FilePath $jsFile.FullName -RootPath $OutputDirPath
    Invoke-ExternalCommand -Stage "obfuscate" -CommandParts @(
      $ObfuscatorCliPath,
      $jsFile.Name,
      "--output", $jsFile.Name,
      "--identifiers-prefix", $identifierPrefix,
      "--config", $ObfuscatorConfigPath
    ) -WorkingDirectory $jsFile.DirectoryName
  }
  Write-Stage -Stage "obfuscate" -Message "Obfuscated $($jsFiles.Count) JavaScript files."

  Validate-ManifestReferences -OutputRoot $OutputDirPath

  Write-Stage -Stage "done" -Message "Build completed successfully. Output directory: $OutputDirPath"
  exit 0
} catch {
  Write-Host $_.Exception.Message
  exit 1
}
