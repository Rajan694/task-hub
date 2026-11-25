#!/usr/bin/env python
"""Stands in for Django's manage.py: prints the command it was given."""
import sys

print("manage", " ".join(sys.argv[1:]))
