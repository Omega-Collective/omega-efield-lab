@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ============================================
echo  Omega E-Field Lab  (modo rapido)
echo ============================================
echo Carpeta: %CD%
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

if defined PY goto :tienepy
echo No encontre simnibs_python.cmd en las rutas habituales.
echo Entra a la carpeta donde instalaste SimNIBS, abre la subcarpeta bin,
echo y arrastra aqui el archivo simnibs_python.cmd. Luego pulsa Enter.
set /p PY=Ruta: 
for %%A in (!PY!) do set "PY=%%~A"

:tienepy
if exist "!PY!" goto :pyok
echo.
echo No existe: !PY!
goto :fin

:pyok
echo Interprete: !PY!
echo.

set "HEAD=%~1"
if defined HEAD goto :tienehead
echo Arrastra sobre esta ventana el archivo ernie.msh y pulsa Enter.
set /p HEAD=Archivo: 
for %%A in (!HEAD!) do set "HEAD=%%~A"

:tienehead
if exist "!HEAD!" goto :headok
echo.
echo No existe el archivo: !HEAD!
goto :fin

:headok
for %%F in ("!HEAD!") do set "NAME=%%~nF"
echo Modelo: !NAME!
echo Archivo: !HEAD!
echo.
echo Paso 1 de 2. Version rapida, con electrodos puntuales.
echo Menos preciso cerca del cuero cabelludo, pero sin la media hora de mallado.
echo.

set "NAME=!NAME!-rapido"
call "!PY!" "tools\compute_leadfield.py" "!HEAD!" -o "leadfield_!NAME!" --rapido
if errorlevel 1 echo.
if errorlevel 1 echo SimNIBS termino con error. Copiame el mensaje de arriba.
if errorlevel 1 goto :fin

set "HDF5="
for %%F in ("leadfield_!NAME!\*.hdf5") do set "HDF5=leadfield_!NAME!\%%~nxF"
if defined HDF5 goto :hdfok
echo No se genero ningun archivo .hdf5.
goto :fin

:hdfok
echo.
echo Paso 2 de 2. Conversion al formato del visor.
echo Archivo: !HDF5!
echo.

call "!PY!" -m pip install fast_simplification --quiet
call "!PY!" "tools\export_leadfield.py" "!HDF5!" -o "models\!NAME!" --name "!NAME!" --vertices 20000
if errorlevel 1 echo.
if errorlevel 1 echo La conversion fallo. Copiame el mensaje de arriba.
if errorlevel 1 goto :fin

echo.
echo Listo. Levanta el sitio con: firebase emulators:start --only hosting
echo Y abre: http://localhost:5000/efield-lab/?model=!NAME!

:fin
echo.
pause
