<#
.SYNOPSIS
  Installs everything, prepares the database, then runs the ClearPort API and web app together.

.DESCRIPTION
  1. Checks Node.js and npm.
  2. npm install (all workspaces).
  3. Creates backend\.env from .env.example (with a fresh random JWT secret) if it does not exist.
  4. Generates the Prisma client, applies database migrations, seeds reference data.
  5. On a brand-new database, creates a demo office and prints the sign-in details.
  6. Starts the API (http://localhost:3000) and the web app (http://localhost:5173); Ctrl+C stops both.

.PARAMETER SkipInstall  Skip "npm install" (faster restarts).
.PARAMETER NoBrowser    Do not open the browser.
.PARAMETER OwnerEmail   Owner of the demo office created on a brand-new database.
.PARAMETER OwnerPassword Password for that owner (a random one is generated and printed if omitted).

.EXAMPLE
  .\run-app.ps1
.EXAMPLE
  .\run-app.ps1 -SkipInstall -NoBrowser
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$NoBrowser,
  [string]$OwnerEmail = 'owner@demo.local',
  [string]$OwnerPassword
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$EnvFile = Join-Path $Backend '.env'
$ApiUrl = 'http://localhost:3000/api/v1'
$WebUrl = 'http://localhost:5173'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

# Runs an npm command and stops the script if it fails.
function Npm {
  param([string[]]$Arguments, [string]$WorkDir = $Root)
  Push-Location $WorkDir
  try {
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "npm $($Arguments -join ' ') failed (exit code $LASTEXITCODE)." }
  } finally { Pop-Location }
}

function Test-PortFree([int]$Port) {
  -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function New-Secret([int]$Bytes = 48) {
  $b = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# ---------------------------------------------------------------- 1. prerequisites
Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed. Install Node 22 or newer from https://nodejs.org and run this script again.' }
$major = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js 22 or newer is required (found $(& node -v))." }
Write-Host "Node $(& node -v), npm $(& npm.cmd -v)"

foreach ($p in 3000, 5173) {
  if (-not (Test-PortFree $p)) { Fail "Port $p is already in use. Stop the other program (or an earlier run of this script) first." }
}

# ---------------------------------------------------------------- 2. dependencies
if ($SkipInstall) {
  Step 'Skipping dependency install (-SkipInstall)'
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Fail 'node_modules is missing; run without -SkipInstall.' }
} else {
  Step 'Installing dependencies (backend and frontend)'
  Npm @('install')
}

# ---------------------------------------------------------------- 3. configuration
Step 'Checking configuration'
if (-not (Test-Path $EnvFile)) {
  $example = Join-Path $Backend '.env.example'
  if (-not (Test-Path $example)) { Fail 'backend\.env.example is missing.' }
  $text = Get-Content $example -Raw
  $text = [regex]::Replace($text, '(?m)^JWT_ACCESS_SECRET=.*$', "JWT_ACCESS_SECRET=`"$(New-Secret)`"")
  [System.IO.File]::WriteAllText($EnvFile, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host 'Created backend\.env with a new random JWT secret.'
} else {
  Write-Host 'backend\.env already exists - keeping it.'
}

# ---------------------------------------------------------------- 4. database
Step 'Preparing the database'
$dbFile = Join-Path $Backend 'dev.db'
$freshDatabase = -not (Test-Path $dbFile)
Npm @('run', 'db:generate') $Backend
Npm @('run', 'db:deploy') $Backend
Npm @('run', 'db:seed') $Backend

if ($freshDatabase) {
  Step 'Creating a demo office (new database)'
  $generated = $false
  if (-not $OwnerPassword) { $OwnerPassword = (New-Secret 12) + 'aA1'; $generated = $true }
  $env:CLEARPORT_OWNER_PASSWORD = $OwnerPassword
  try {
    Npm @('run', 'tenant:create', '--', '--name', 'Demo Office', '--slug', 'demo', '--owner-email', $OwnerEmail, '--owner-first', 'Demo', '--owner-last', 'Owner') $Backend
  } finally { Remove-Item Env:\CLEARPORT_OWNER_PASSWORD -ErrorAction SilentlyContinue }
  Write-Host ''
  Write-Host '  Sign in with:' -ForegroundColor Green
  Write-Host "    Email:    $OwnerEmail" -ForegroundColor Green
  Write-Host "    Password: $OwnerPassword$(if ($generated) { '   (generated - save it now, it is not shown again)' })" -ForegroundColor Green
}

# ---------------------------------------------------------------- 5. run both
Step 'Starting the API and the web app (Ctrl+C stops both)'
$procs = @()
try {
  $api = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'start', '-w', 'backend') -WorkingDirectory $Root -NoNewWindow -PassThru
  $web = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '-w', 'frontend') -WorkingDirectory $Root -NoNewWindow -PassThru
  $procs = @($api, $web)

  Write-Host 'Waiting for the API...'
  $ready = $false
  for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
    if ($api.HasExited -or $web.HasExited) { Fail 'A process stopped during start-up; see the messages above.' }
    try { $ready = (Invoke-WebRequest "$ApiUrl/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { Fail 'The API did not become ready within 90 seconds.' }

  Write-Host ''
  Write-Host "  API:  $ApiUrl" -ForegroundColor Green
  Write-Host "  Web:  $WebUrl" -ForegroundColor Green
  Write-Host '  Press Ctrl+C to stop.' -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process $WebUrl }

  while (-not $api.HasExited -and -not $web.HasExited) { Start-Sleep -Seconds 1 }
  Write-Host 'One of the processes stopped; shutting down.' -ForegroundColor Yellow
} finally {
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { & taskkill.exe /PID $p.Id /T /F *> $null }  # kills npm and its node children
  }
}
