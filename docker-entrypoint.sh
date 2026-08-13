#!/bin/sh
# Single-container run: app + Caddy (auto-HTTPS) in one image.
#   DOMAIN set   -> Caddy fronts the app with a Let's Encrypt cert on 80/443.
#   DOMAIN unset -> just the app on 3030 (local / no-TLS).
# ponytail: app runs in the background; if it dies Caddy stays up and 502s.
# Fine for a single box — add a supervisor only if you need auto-restart.
set -e

if [ -n "$DOMAIN" ]; then
	export COOKIE_SECURE="${COOKIE_SECURE:-1}"   # HTTPS -> secure session cookie
	./rustpad-server &
	exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
fi

exec ./rustpad-server
