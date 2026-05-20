@echo off
setlocal enabledelayedexpansion
title Overworld Visitor Setup

echo ========================================
echo   Overworld Visitor - Setup and Run
echo ========================================
echo.

:: ── Admin check ──
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)
echo [OK] Administrator

:: ── .NET SDK ──
echo Checking .NET SDK...
dotnet --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing .NET SDK 10.0...
    winget install Microsoft.DotNet.SDK.10 --silent --accept-source-agreements --accept-package-agreements
    echo [DONE] .NET SDK installed. Restart this script after install.
    pause
    exit /b
)
for /f "tokens=*" %%i in ('dotnet --version') do set DOTNET_VER=%%i
echo [OK] .NET SDK v%DOTNET_VER%

:: ── Docker ──
echo Checking Docker...
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Docker Desktop...
    winget install Docker.DockerDesktop --silent --accept-source-agreements --accept-package-agreements
    echo [DONE] Docker installed. Please restart your computer and run this script again.
    pause
    exit /b
)
for /f "tokens=*" %%i in ('docker --version') do set DOCKER_VER=%%i
echo [OK] %DOCKER_VER%

:: ── Build GUI ──
echo.
echo Building GUI...
cd /d "%~dp0"
dotnet build gui\OverworldVisitor.csproj -c Release --nologo -v q
if %errorlevel% neq 0 (
    echo [FAIL] GUI build failed!
    pause
    exit /b 1
)
echo [OK] GUI built successfully

:: ── Build bot Docker image ──
echo.
echo Building bot Docker image...
docker compose build visitor
if %errorlevel% neq 0 (
    echo [WARN] Docker build failed. Start the server first and use "Rebuild Bot" in the GUI.
)

:: ── Run GUI ──
echo.
echo Launching Overworld Visitor GUI...
start "" gui\bin\Release\net10.0-windows\OverworldVisitor.exe
exit
