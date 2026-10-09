#!/bin/sh
if grep -q 'git push --tags'; then echo 'Pushing tags is the release workflow job.' >&2; exit 2; fi
