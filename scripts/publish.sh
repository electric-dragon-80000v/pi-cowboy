#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${repo_root}"

dry_run=false

for arg in "$@"; do
  case "${arg}" in
    --dry-run|-n)
      dry_run=true
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--dry-run]"
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: $(basename "$0") [--dry-run]" >&2
      exit 1
      ;;
  esac
done

command -v jq >/dev/null 2>&1 || {
  echo "Error: jq is required to parse staged package metadata." >&2
  exit 1
}

git pull

pkg_version="$(jq -r .version package.json)"
metadata="$(npm stage list --json | jq -r --arg v "${pkg_version}" '.[] | select(.version == $v)')"

if [ -z "${metadata}" ]; then
  echo "Error: no staged package found for version ${pkg_version}" >&2
  exit 1
fi

version="$(printf '%s\n' "${metadata}" | jq -r '.version // empty')"
id="$(printf '%s\n' "${metadata}" | jq -r '.id // empty')"

if [ -z "${version}" ] || [ -z "${id}" ]; then
  echo "Error: staged package metadata did not contain a valid version and id." >&2
  exit 1
fi

if [ "${dry_run}" = true ]; then
  echo "Would approve version ${version} (stage id: ${id})"
  exit 0
fi

read -r -p "Approve version ${version}? (y/n) " answer
case "${answer}" in
  [yY]|[yY][eE][sS])
    npm stage approve "${id}"
    ;;
  *)
    echo "Aborted."
    exit 1
    ;;
esac
