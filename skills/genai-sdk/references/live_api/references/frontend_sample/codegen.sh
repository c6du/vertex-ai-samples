#!/usr/bin/env bash
# Regenerate TypeScript + Python proto bindings.
#
# Inputs:
#   ../client_server_messages.proto   (the reconstructed Live API wire schema)
#   proto/recorded_frame.proto        (portable wrapper for session recordings)
#
# Outputs:
#   gen/                              (TypeScript: @bufbuild/protobuf shapes)
#   server/gen/                       (Python: standard google.protobuf classes)
#
# Prerequisites:
#   - `npm install` has been run (provides @bufbuild/protoc-gen-es).
#   - Python venv has `grpcio-tools` installed (provides `python -m grpc_tools.protoc`).
#     Equivalently, a system `protoc` >= 25.x with `protoc-gen-es` on PATH works.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

mkdir -p gen server/gen

# Stage the upstream reconstructed proto into ./proto/ so a single -I root
# covers everything (some protoc versions choke on `..` imports).
mkdir -p proto
cp ../client_server_messages.proto proto/client_server_messages.proto

# ---- TypeScript: @bufbuild/protoc-gen-es ----
# Generates `*_pb.ts` modules with discriminated-union oneofs.
TS_PLUGIN="$HERE/node_modules/.bin/protoc-gen-es"
if [[ ! -x "$TS_PLUGIN" ]]; then
  echo "error: protoc-gen-es not found at $TS_PLUGIN. Run 'npm install' first." >&2
  exit 1
fi

# We try `buf generate` first (preferred); fall back to raw protoc if `buf` is
# absent. Either path produces the same `gen/*_pb.ts` files.
if command -v buf >/dev/null 2>&1; then
  buf generate
else
  echo "buf not on PATH; falling back to protoc."
  protoc \
    --plugin="protoc-gen-es=$TS_PLUGIN" \
    --es_out=gen \
    --es_opt=target=ts,import_extension=js \
    -I proto \
    proto/client_server_messages.proto \
    proto/recorded_frame.proto
fi

# ---- Python: standard google.protobuf ----
# Uses `python -m grpc_tools.protoc` (ships with the `grpcio-tools` pip
# package) because it bundles the protoc binary, so users don't need to
# install protoc separately.
PYTHON="${PYTHON:-python3}"
"$PYTHON" -m grpc_tools.protoc \
  -I proto \
  --python_out=server/gen \
  proto/client_server_messages.proto \
  proto/recorded_frame.proto

# `grpc_tools.protoc` emits absolute imports (`import client_server_messages_pb2`)
# which work because we add `server/gen` to sys.path in server/server.py.

# Marker so users know the directory is generated.
touch gen/.generated server/gen/.generated
cat > gen/README.md <<'EOF'
# gen/ (generated TypeScript proto bindings)

Do not edit. Regenerate with `npm run gen` or `bash codegen.sh`.
EOF
cat > server/gen/README.md <<'EOF'
# server/gen/ (generated Python proto bindings)

Do not edit. Regenerate with `bash ../codegen.sh`.
EOF

# `server/gen/__init__.py` lets the directory be imported as a package even
# though we add it to sys.path directly in server.py.
touch server/gen/__init__.py

echo "Codegen complete."
echo "  TypeScript: gen/"
echo "  Python:     server/gen/"
