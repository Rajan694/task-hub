#!/usr/bin/env bash
name=${2:-world}
case "$1" in
  hello) echo "hello $name" ;;
  bye|later) echo "bye $name" ;;
  -h|--help) echo "usage: greet.sh hello|bye [name]" ;;
  *) echo "unknown: $1"; exit 2 ;;
esac
awk '{print $3}' /dev/null # don't count $3
