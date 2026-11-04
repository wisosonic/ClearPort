@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------------
rem  ClearPort - installs everything, prepares the database, then runs the API
rem  and the web app together.
rem
rem  Usage:  runner.bat [-SkipInstall] [-NoBrowser] [-OwnerEmail x] [-OwnerPassword y]
rem          (a leading / works too: /SkipInstall)
rem
rem   -SkipInstall    skip "npm install" (faster restarts)
rem   -NoBrowser      do not open the browser
rem   -OwnerEmail     owner of the demo office created on a brand-new database
rem   -OwnerPassword  its password (a random one is generated and shown if omitted)
rem ---------------------------------------------------------------------------

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BACKEND=%ROOT%\backend"
set "ENVFILE=%BACKEND%\.env"
set "API_URL=http://localhost:3000/api/v1"
set "WEB_URL=http://localhost:5173"
set "SKIP_INSTALL=0"
set "NO_BROWSER=0"
set "OWNER_EMAIL=owner@demo.local"
set "OWNER_PASSWORD="
set "GENERATED=0"

:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
if "%ARG:~0,1%"=="/" set "ARG=-%ARG:~1%"
if /i "%ARG%"=="-SkipInstall"   set "SKIP_INSTALL=1" & shift & goto parse
if /i "%ARG%"=="-NoBrowser"     set "NO_BROWSER=1" & shift & goto parse
if /i "%ARG%"=="-OwnerEmail"    set "OWNER_EMAIL=%~2" & shift & shift & goto parse
if /i "%ARG%"=="-OwnerPassword" set "OWNER_PASSWORD=%~2" & shift & shift & goto parse
echo Unknown option: %~1
exit /b 1
:parsed

cd /d "%ROOT%"

rem ------------------------------------------------------------ 1. prerequisites
echo.
echo ==^> Checking Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed. Install Node 22 or newer from https://nodejs.org and run this script again.
  exit /b 1
)
set "NODEMAJOR="
for /f "usebackq delims=" %%v in (`node -e "console.log(process.versions.node.split('.')[0])"`) do set "NODEMAJOR=%%v"
if not defined NODEMAJOR (
  echo ERROR: could not read the Node.js version.
  exit /b 1
)
if %NODEMAJOR% LSS 22 (
  echo ERROR: Node.js 22 or newer is required, found major version %NODEMAJOR%.
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node %%v

for %%p in (3000 5173) do (
  call :listening %%p
  if not errorlevel 1 (
    echo ERROR: Port %%p is already in use. Stop the other program, or an earlier run of this script, first.
    exit /b 1
  )
)

rem ------------------------------------------------------------ 2. dependencies
if "%SKIP_INSTALL%"=="1" (
  echo.
  echo ==^> Skipping dependency install
  if not exist "%ROOT%\node_modules" (
    echo ERROR: node_modules is missing; run without -SkipInstall.
    exit /b 1
  )
) else (
  echo.
  echo ==^> Installing dependencies - backend and frontend
  call npm install
  if errorlevel 1 goto :failed
)

rem ------------------------------------------------------------ 3. configuration
echo.
echo ==^> Checking configuration
if exist "%ENVFILE%" (
  echo backend\.env already exists - keeping it.
) else (
  if not exist "%BACKEND%\.env.example" (
    echo ERROR: backend\.env.example is missing.
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $s=[Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_'); $q=[char]34; $t=Get-Content -Raw 'backend\.env.example'; $t=[regex]::Replace($t,'(?m)^JWT_ACCESS_SECRET=.*$','JWT_ACCESS_SECRET='+$q+$s+$q); [IO.File]::WriteAllText('backend\.env',$t,(New-Object Text.UTF8Encoding($false)))"
  if errorlevel 1 goto :failed
  echo Created backend\.env with a new random JWT secret.
)

rem ------------------------------------------------------------ 4. database
echo.
echo ==^> Preparing the database
set "FRESH=0"
if not exist "%BACKEND%\dev.db" set "FRESH=1"
pushd "%BACKEND%"
call npm run db:generate
if errorlevel 1 popd & goto :failed
call npm run db:deploy
if errorlevel 1 popd & goto :failed
call npm run db:seed
if errorlevel 1 popd & goto :failed
popd

if "%FRESH%"=="1" (
  echo.
  echo ==^> Creating a demo office - new database
  if not defined OWNER_PASSWORD (
    for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$b=New-Object byte[] 12; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')+'aA1'"`) do set "OWNER_PASSWORD=%%v"
    set "GENERATED=1"
  )
  set "CLEARPORT_OWNER_PASSWORD=%OWNER_PASSWORD%"
  pushd "%BACKEND%"
  call npm run tenant:create -- --name "Demo Office" --slug demo --owner-email "%OWNER_EMAIL%" --owner-first Demo --owner-last Owner
  set "RC=%ERRORLEVEL%"
  popd
  set "CLEARPORT_OWNER_PASSWORD="
  if not "%RC%"=="0" goto :failed
  echo.
  echo   Sign in with:
  echo     Email:    %OWNER_EMAIL%
  if "%GENERATED%"=="1" (
    echo     Password: %OWNER_PASSWORD%   - generated, save it now, it is not shown again
  ) else (
    echo     Password: %OWNER_PASSWORD%
  )
)

rem ------------------------------------------------------------ 5. run both
echo.
echo ==^> Starting the API and the web app
start "" /b cmd /c "npm run start -w backend" <nul
start "" /b cmd /c "npm run dev -w frontend" <nul

echo Waiting for the API...
set /a TRIES=0
:wait
set /a TRIES+=1
if %TRIES% GTR 90 (
  echo ERROR: The API did not become ready within 90 seconds. See the messages above.
  call :stopall
  exit /b 1
)
set "CODE="
for /f "delims=" %%c in ('curl.exe -s -o nul -m 2 -w "%%{http_code}" "%API_URL%/health" 2^>nul') do set "CODE=%%c"
if "%CODE%"=="200" goto ready
>nul ping -n 2 127.0.0.1
goto wait

:ready
echo.
echo   API:  %API_URL%
echo   Web:  %WEB_URL%
echo   Press Q in this window to stop both. They also stop if either one exits.
if "%NO_BROWSER%"=="0" start "" "%WEB_URL%"

:monitor
choice /c NQ /n /t 3 /d N >nul
if errorlevel 2 goto stop
call :listening 3000
if errorlevel 1 goto gone
call :listening 5173
if errorlevel 1 goto gone
goto monitor

:gone
echo One of the processes stopped; shutting down.
:stop
call :stopall
echo Stopped.
endlocal
exit /b 0

:failed
echo.
echo ERROR: a step failed - see the messages above.
exit /b 1

rem ---------------------------------------------------------------- subroutines
:listening
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul
exit /b

:killport
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%~1 .*LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
exit /b

:stopall
call :killport 3000
call :killport 5173
exit /b
