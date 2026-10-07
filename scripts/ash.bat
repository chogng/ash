@echo off
setlocal
pushd "%~dp0.." || exit /b 1

if "%~1"=="" goto full
if "%~1"=="--connected" goto connected

>&2 echo Unknown Ash launch mode: %~1
popd
exit /b 2

:full
call just ash
set "result=%errorlevel%"
popd
exit /b %result%

:connected
call pnpm dev:ui:connected
set "result=%errorlevel%"
popd
exit /b %result%
