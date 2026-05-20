@echo off
setlocal
cd /d "%~dp0"

echo Launching Overworld Visitor GUI...

if not exist "gui\bin\Release\net10.0-windows\OverworldVisitor.exe" (
    echo Release build not found. Building GUI...
    dotnet build "gui\OverworldVisitor.csproj" -c Release --nologo -v q
    if %errorlevel% neq 0 (
        echo [FAIL] GUI build failed.
        pause
        exit /b 1
    )
)

start "" "%~dp0gui\bin\Release\net10.0-windows\OverworldVisitor.exe"
