#!/usr/bin/env bash
# Build romdeck's H.264 video-snap decoder to WASM, from ffmpeg's sources.
#
# WHY THIS EXISTS
#
# Video snaps were the one thing Electron genuinely provided (<video> and its
# decoder). Replacing it must not mean bundling an executable — that rule is
# absolute in this project, and `ffmpeg-static` was proposed once and
# correctly rejected. So the decoder is built from source to WASM, exactly the
# way romdev builds every emulator core: upstream is FETCHED and pinned, never
# vendored, and the artifact is a .wasm the app loads.
#
# SCOPE IS DELIBERATELY TINY
#
# A snap is a short, silent, single-track H.264 clip. ES-DE's own extension
# list puts .mp4 first (es-app/src/FileData.h), and every scraper writes
# MP4/H.264. So this configures ffmpeg down to ONE decoder and nothing else:
# no muxers, no encoders, no protocols, no audio, no filters, no CLI tools.
# Demuxing is done in JS (src/ui/video/mp4.js) because container parsing is
# pure structure and does not need native code.
#
# The result is libavcodec's h264 decoder and nothing more — a few hundred KB
# rather than a general-purpose media stack.
#
# Output: src/ui/video/wasm/h264.{js,wasm}
set -euo pipefail

FFMPEG_REF="${FFMPEG_REF:-n6.1.1}"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/romdeck-build}"
SRC="$BUILD_DIR/ffmpeg"
OUT="$(cd "$(dirname "$0")/.." && pwd)/src/ui/video/wasm"

command -v emcc >/dev/null || {
  echo "FATAL: emcc not found. Activate emsdk first:" >&2
  echo "  source ~/code/mine/emsdk/emsdk_env.sh" >&2
  exit 1
}
command -v git >/dev/null || { echo "FATAL: git required" >&2; exit 1; }

mkdir -p "$BUILD_DIR" "$OUT"

if [ ! -d "$SRC" ]; then
  echo "Fetching ffmpeg $FFMPEG_REF (shallow) …"
  git clone --depth 1 --branch "$FFMPEG_REF" https://git.ffmpeg.org/ffmpeg.git "$SRC"
fi

cd "$SRC"

# Configure to the smallest thing that can decode an H.264 snap.
# --disable-everything then enabling exactly one decoder is the point: a
# general ffmpeg build would be tens of MB of code romdeck never calls.
if [ ! -f config.h ] || [ "${RECONFIGURE:-0}" = "1" ]; then
  echo "Configuring …"
  emconfigure ./configure \
    --prefix="$SRC/dist" \
    --target-os=none \
    --arch=x86_32 \
    --enable-cross-compile \
    --disable-x86asm \
    --disable-inline-asm \
    --disable-stripping \
    --disable-programs \
    --disable-doc \
    --disable-avdevice \
    --disable-avformat \
    --disable-swresample \
    --disable-swscale \
    --disable-avfilter \
    --disable-network \
    --disable-everything \
    --enable-decoder=h264 \
    --enable-avcodec \
    --enable-avutil \
    --nm=emnm \
    --ar=emar \
    --ranlib=emranlib \
    --cc=emcc \
    --cxx=em++ \
    --objcc=emcc \
    --dep-cc=emcc
fi

echo "Building libavcodec/libavutil …"
emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a

echo "Linking the decoder shim …"
emcc -O3 \
  -I"$SRC" \
  "$(dirname "$0")/../src/ui/video/decoder.c" \
  "$SRC/libavcodec/libavcodec.a" \
  "$SRC/libavutil/libavutil.a" \
  -o "$OUT/h264.js" \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createH264Decoder \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=node \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8"]' \
  -s EXPORTED_FUNCTIONS='["_h264_open","_h264_decode","_h264_frame_ptr","_h264_width","_h264_height","_h264_close","_malloc","_free"]'

echo "Built $OUT/h264.wasm ($(du -h "$OUT/h264.wasm" | cut -f1))"
