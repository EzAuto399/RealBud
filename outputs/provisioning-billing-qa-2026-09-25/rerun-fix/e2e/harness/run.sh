#!/bin/zsh
export PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH
H=/private/tmp/claude-501/-Users-yoda-projects-RealBud/1e5b5f5f-34c1-402c-9819-6956729fe386/scratchpad
V=$1; R=$2; shift 2
cd $H/harness && env VARIANT=$V RB_ROOT=$R OUT=${OUT_OVERRIDE:-/Users/yoda/projects/RealBud/outputs/provisioning-billing-qa-2026-09-25/e2e} QA_SCRATCH=$H MV_TREE=$H/mv "$@" node --experimental-strip-types --no-warnings --import ./register.mjs e2e.mjs
