@echo off
echo Starting Overworld Visitor (all regions)...
echo This runs the Minecraft server + bot together.
echo Press Ctrl+C to stop.
echo.
docker compose up --abort-on-container-exit mc visitor
echo.
echo Done. Server stopped.
pause
