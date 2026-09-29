#!/bin/sh
# stop sandbox $1: app processes (by user-data-dir) then its detached service (by service.json pid, verified cmdline)
B=/private/tmp/claude-501/-Users-yoda-projects-RealBud/1e5b5f5f-34c1-402c-9819-6956729fe386/scratchpad/qa/$1
pk=$(pgrep -f "qa/$1/ud"); [ -n "$pk" ] && kill -9 $pk
D=${2:-$B/home/.realbud}
[ -f "$D/service.json" ] && SP=$(python3 -c "import json;print(json.load(open('$D/service.json'))['pid'])") && ps -p $SP -o command= | grep -q bootstrap.js && [ "$SP" != 7376 ] && kill -TERM $SP && sleep 2 && (ps -p $SP >/dev/null && kill -9 $SP)
pgrep -f "qa/$1/" | xargs -I{} ps -o pid=,command= -p {} | cut -c1-100
true
