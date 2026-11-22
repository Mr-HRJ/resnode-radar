#!/bin/sh
set -eu

case " ${RENEWED_DOMAINS:-} " in
  *" vps.bnoai.com "*)
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
    ;;
esac
