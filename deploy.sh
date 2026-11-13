#!/usr/bin/env bash
# Deploys teleglance: builds its image from this folder and recreates the teleglance service,
# and nothing else.
# The deploy.sh contract is in ~/Projects/homelab/dashboard/README.md ("deploy.sh contract").
#   ./deploy.sh           deploy
#   ./deploy.sh --check   check the prerequisites; changes nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

project=even-g2-tele-glance
compose_file=docker-compose.yml
services=(teleglance)

compose() { docker compose -p "$project" -f "$compose_file" "$@"; }

check() {
	command -v docker >/dev/null || { echo "docker is not installed" >&2; return 1; }
	[[ -f $compose_file ]] || { echo "$compose_file is missing" >&2; return 1; }
	# --quiet: the full output would hold the values from .env.
	compose config --quiet "${services[@]}"
}

deploy() {
	compose build "${services[@]}"
	compose up -d --no-deps "${services[@]}"
}

if (($# > 1)); then
	echo "usage: deploy.sh [--check]" >&2
	exit 2
fi
case "${1:-}" in
--check)
	check
	echo "ok: a deploy would run"
	exit 0
	;;
"") ;;
*)
	echo "usage: deploy.sh [--check]" >&2
	exit 2
	;;
esac

check
deploy
echo "deployed"
