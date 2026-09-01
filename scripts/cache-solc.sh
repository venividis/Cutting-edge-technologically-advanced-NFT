#!/usr/bin/env bash
set -euo pipefail

# Hardhat's downloader does not honor every managed environment's proxy setup. curl generally
# does, so this command primes Hardhat's normal global cache without modifying node_modules.
version="${SOLC_VERSION:-0.8.28}"
repository="${SOLC_REPOSITORY_URL:-https://binaries.soliditylang.org}"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/hardhat-nodejs/compilers-v3"
list_tmp=""
compiler_tmp=""
trap 'rm -f "${list_tmp:-}" "${compiler_tmp:-}"' EXIT

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) native_platform="linux-amd64" ;;
  Darwin-x86_64|Darwin-arm64) native_platform="macosx-amd64" ;;
  *) native_platform="" ;;
esac

platforms=(wasm)
if [[ -n "$native_platform" ]]; then
  platforms=("$native_platform" wasm)
fi

for platform in "${platforms[@]}"; do
  destination="$cache_root/$platform"
  mkdir -p "$destination"
  list_tmp="$(mktemp "$destination/list.json.XXXXXX")"
  curl --fail --location --silent --show-error \
    "$repository/$platform/list.json" -o "$list_tmp"

  read -r filename expected_sha < <(node - "$list_tmp" "$version" <<'NODE'
const [listPath, version] = process.argv.slice(2);
const list = JSON.parse(require("node:fs").readFileSync(listPath, "utf8"));
const build = list.builds.find((candidate) => candidate.version === version && !candidate.prerelease);
if (build === undefined) throw new Error(`solc ${version} is absent from ${listPath}`);
process.stdout.write(`${build.path} ${build.sha256.replace(/^0x/, "")}\n`);
NODE
  )

  compiler_tmp="$(mktemp "$destination/compiler.XXXXXX")"
  curl --fail --location --silent --show-error \
    "$repository/$platform/$filename" -o "$compiler_tmp"
  actual_sha="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$compiler_tmp")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    rm -f "$list_tmp" "$compiler_tmp"
    echo "Checksum mismatch for $platform/$filename" >&2
    exit 1
  fi
  chmod +x "$compiler_tmp"
  mv "$compiler_tmp" "$destination/$filename"
  mv "$list_tmp" "$destination/list.json"
  echo "Cached verified solc $version: $platform/$filename"
done
