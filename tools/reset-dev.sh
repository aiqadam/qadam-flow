#!/bin/sh
# Resets the VS Code dev container defined in .devcontainer/docker-compose.yml.
# Container and volume names are left to compose rather than hardcoded, because
# the project prefix depends on how the dev container was launched.
set -eu

rm -rf ~/.activepieces
rm -rf node_modules/

docker compose -f .devcontainer/docker-compose.yml down --volumes --remove-orphans

echo "Deleted the Qadam Flow dev container, its volumes, node_modules and ~/.activepieces."
