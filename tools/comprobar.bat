@echo off
setlocal enabledelayedexpansion
echo Comprobacion del entorno
echo.
echo Carpeta de este archivo: %~dp0
echo.
set "PY="
for /f "delims=" %%i in ('where simnibs_python 2^>nul') do set "PY=%%i"
if defined PY set "PY=simnibs_python"
if not defined PY for /d %%D in ("%LOCALAPPDATA%\SimNIBS*") do if exist "%%~D\bin\simnibs_python.cmd" set "PY=%%~D\bin\simnibs_python.cmd"
if not defined PY for /d %%D in ("%LOCALAPPDATA%\Programs\SimNIBS*") do if exist "%%~D\bin\simnibs_python.cmd" set "PY=%%~D\bin\simnibs_python.cmd"
if not defined PY for /d %%D in ("%USERPROFILE%\SimNIBS*") do if exist "%%~D\bin\simnibs_python.cmd" set "PY=%%~D\bin\simnibs_python.cmd"
if not defined PY for /d %%D in ("%ProgramFiles%\SimNIBS*") do if exist "%%~D\bin\simnibs_python.cmd" set "PY=%%~D\bin\simnibs_python.cmd"
if not defined PY for /d %%D in ("C:\SimNIBS*") do if exist "%%~D\bin\simnibs_python.cmd" set "PY=%%~D\bin\simnibs_python.cmd"
if not defined PY for /d %%D in ("D:\SimNIBS*") do if exist "%%~D\bin\simnibs_python.cmd" set "PY=%%~D\bin\simnibs_python.cmd"
if not defined PY echo simnibs_python.cmd: NO ENCONTRADO
if defined PY echo simnibs_python.cmd: !PY!
echo.
if defined PY call "!PY!" -c "import simnibs, sys; print('SimNIBS', simnibs.__version__); print('Python', sys.version.split()[0])"
echo.
pause
