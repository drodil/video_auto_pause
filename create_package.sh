#!/bin/sh

zip -r package.zip . \
  -x ".*" \
  -x "*/.*" \
  -x "create_package.sh" \
  -x "package.zip" \
  -x ".DS_Store" \
  -x "README.md" \
  -x "LICENSE" \
  -x "yt_auto_pause.png"