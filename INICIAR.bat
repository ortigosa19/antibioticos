@echo off
setlocal ENABLEDELAYEDEXPANSION

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ❌ Node.js no está instalado o no está en el PATH.
  echo    Descárgalo e instálalo desde https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo ==============================
echo   Meteo / Antibioticos LOCAL
echo ==============================
echo.

if not exist "backend\node_modules" (
  echo 📦 Instalando dependencias (solo la primera vez)...
  npm --prefix backend install
  if errorlevel 1 (
    echo.
    echo ❌ Error instalando dependencias.
    pause
    exit /b 1
  )
)

echo 🚀 Iniciando servidor en http://localhost:8080 ...
start "" cmd /c "npm --prefix backend start"

echo ⏳ Abriendo navegador...
ping 127.0.0.1 -n 3 >nul
start "" "http://localhost:8080"

echo.
echo (Para cerrar: cierra la ventana del servidor)
echo.
endlocal
