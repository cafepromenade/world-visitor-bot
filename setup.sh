#!/bin/bash
echo "Launching Overworld Visitor GUI..."
cd "$(dirname "$0")"
dotnet run --project gui/OverworldVisitor.csproj -c Release
