@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ============================================
echo  Omega E-Field Lab  (conversion)
echo ============================================
echo Carpeta: %CD%
echo.

set "PY="
for /f "delims=" %%i in ('where simnibs_python 2^>nul') do set "PY=simnibs_python"
if not defined PY echo No encontre simnibs_python en el PATH.
if not defined PY goto :fin

set "HDF5=%~1"
if defined HDF5 goto :tiene
for /r "%CD%" %%F in (*_leadfield_*.hdf5) do set "HDF5=%%F"
if not defined HDF5 echo No encontre ningun archivo *_leadfield_*.hdf5 bajo %CD%
if not defined HDF5 goto :fin

:tiene
set "HDF5=!HDF5:"=!"
if not exist "!HDF5!" echo No existe: !HDF5!
if not exist "!HDF5!" goto :fin

for %%F in ("!HDF5!") do set "BASE=%%~nF"
for /f "tokens=1 delims=_" %%A in ("!BASE!") do set "NAME=%%A"

echo Archivo:  !HDF5!
echo Modelo:   !NAME!
echo.

call "!PY!" -m pip install fast_simplification --quiet
call "!PY!" "tools\export_leadfield.py" "!HDF5!" -o "models\!NAME!" --name "!NAME!" --vertices 20000
if errorlevel 1 echo.
if errorlevel 1 echo Fallo la conversion. Copiame el mensaje de arriba.
if errorlevel 1 goto :fin

echo.
echo Listo. Levanta el sitio con: python -m http.server 5000
echo Y abre: http://localhost:5000/efield-lab/?model=!NAME!

:fin
echo.
pause
