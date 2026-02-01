#!/bin/bash

# Check if flatc is installed
if ! command -v flatc &> /dev/null; then
    echo "❌ Error: 'flatc' is not installed or not in PATH."
    echo "Please install Flatbuffers compiler (v23+ recommended)."
    exit 1
fi

echo "🚀 Generating Flatbuffer files..."

# Ensure target directory exists
mkdir -p lib/fbs

# Generate JS/TS files
# --ts: Generate TypeScript definitions (useful for VSCode intellisense/checking even in JS)
# --js: Generate JavaScript code
# --no-fb-import: Don't generate 'import { flatbuffers } from ...' (we handle imports manually or use the library)
# --gen-object-api: Generate unpack() / pack() methods for object-based access
# --es6: Use ES6 modules
# -o lib/fbs: Output directory
# schema/*.fbs: Input files

flatc --ts --js --no-fb-import --gen-object-api --es6 -o lib/fbs schema/*.fbs

if [ $? -eq 0 ]; then
    echo "✅ Success: Flatbuffers generated in lib/fbs/"
else
    echo "❌ Error: Generation failed."
    exit 1
fi
