#!/usr/bin/env bash
# Cross-compile maximevince/fbDOOM for Kandelo using
# wasm32posix-cc. The fbdev frontend writes BGRA32 pixels into the
# framebuffer mmap; the canvas renderer (host/src/framebuffer/canvas-renderer.ts)
# consumes them.
#
# Output: packages/registry/fbdoom/fbdoom.wasm
#
# Usage: bash packages/registry/fbdoom/build-fbdoom.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/fbdoom-src"
CDOOM_SRC="$HERE/chocolate-doom-src"

# Pin to chocolate-doom 3.1.0. fbDOOM stripped its OPL/MIDI/MUS sources
# when removing SDL; we vendor them back so the music path compiles.
CDOOM_COMMIT="35fb1372d10756ca27eca05665bd8a7cebc71c05" # chocolate-doom-3.1.0

# Vendored net sources from chocolate-doom needed by
# patches/0007-i_net-posix.patch. fbDOOM kept the multiplayer headers but
# dropped the implementations when it removed SDL; we vendor them back so
# FEATURE_MULTIPLAYER can use a POSIX UDP transport over Kandelo's WebRTC
# relay. Skipped intentionally: net_dedicated.{c,h} (headless server),
# net_gui.c (textscreen UI; patch provides NET_WaitForLaunch), and net_sdl.c
# (replaced by net_posix.c).
CDOOM_NET_FILES=(
    aes_prng.c aes_prng.h
    d_loop.h
    net_client.c net_client.h
    net_common.c net_common.h
    net_defs.h
    net_io.c net_io.h
    net_loop.c net_loop.h
    net_packet.c net_packet.h
    net_petname.c net_petname.h
    net_query.c net_query.h
    net_sdl.h
    net_server.c net_server.h
    net_structrw.c net_structrw.h
)

# Use this worktree's SDK and sysroot rather than the global `npm link`
# (which may point at a sibling worktree without our linux/fb.h overlay).
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

if [ ! -d "$SRC" ]; then
    echo "==> Cloning maximevince/fbDOOM..."
    git clone --depth 1 https://github.com/maximevince/fbDOOM "$SRC"
fi

# Sentinels for patch groups. Existing local source trees may have the
# audio/music patches but not the multiplayer patch; keep this incremental so
# developers do not have to delete fbdoom-src when this package gains net_posix.
MUSIC_SENTINEL="$SRC/fbdoom/opl/opl_kernel.c"
NET_SENTINEL="$SRC/fbdoom/net_posix.c"

ensure_chocolate_doom() {
    if [ ! -d "$CDOOM_SRC" ]; then
        echo "==> Cloning chocolate-doom @ $CDOOM_COMMIT for vendored sources..."
        # Shallow-by-commit needs `--filter=blob:none` since github
        # archives don't carry refs/tags reachability for arbitrary SHAs.
        git clone --filter=blob:none --no-checkout \
            https://github.com/chocolate-doom/chocolate-doom "$CDOOM_SRC"
        (cd "$CDOOM_SRC" && git checkout "$CDOOM_COMMIT")
    elif [ "$(cd "$CDOOM_SRC" && git rev-parse HEAD)" != "$CDOOM_COMMIT" ]; then
        echo "==> Re-pinning chocolate-doom to $CDOOM_COMMIT..."
        (cd "$CDOOM_SRC" && git fetch && git checkout "$CDOOM_COMMIT")
    fi
}

vendor_music_sources() {
    echo "==> Vendoring OPL/MIDI/MUS sources from chocolate-doom..."
    mkdir -p "$SRC/fbdoom/opl"
    for f in opl.c opl.h opl3.c opl3.h opl_internal.h opl_queue.c opl_queue.h; do
        cp "$CDOOM_SRC/opl/$f" "$SRC/fbdoom/opl/$f"
    done
    for f in mus2mid.c mus2mid.h midifile.c midifile.h; do
        cp "$CDOOM_SRC/src/$f" "$SRC/fbdoom/$f"
    done
}

vendor_net_sources() {
    echo "==> Vendoring multiplayer NET sources from chocolate-doom..."
    for f in "${CDOOM_NET_FILES[@]}"; do
        cp "$CDOOM_SRC/src/$f" "$SRC/fbdoom/$f"
    done
}

apply_patches() {
    local mode="${1:-strict}"
    echo "==> Applying patches..."
    for p in "$HERE/patches/"*.patch; do
        [ -f "$p" ] || continue
        name="$(basename "$p")"
        if (cd "$SRC" && git apply --check "$p") >/dev/null 2>&1; then
            echo "    $name"
            (cd "$SRC" && git apply "$p")
        elif [ "$mode" = "lenient" ]; then
            echo "    $name (already applied or superseded)"
        else
            echo "ERROR: patch $name does not apply cleanly" >&2
            exit 1
        fi
    done
}

needs_music=0
needs_net=0
[ -e "$MUSIC_SENTINEL" ] || needs_music=1
[ -e "$NET_SENTINEL" ] || needs_net=1

if [ "$needs_music" -eq 1 ] || [ "$needs_net" -eq 1 ]; then
    ensure_chocolate_doom
    [ "$needs_music" -eq 0 ] || vendor_music_sources
    [ "$needs_net" -eq 0 ] || vendor_net_sources
    if [ "$needs_music" -eq 1 ] && [ "$needs_net" -eq 1 ]; then
        apply_patches strict
    else
        apply_patches lenient
    fi
else
    echo "==> Source tree already vendored (sentinels present); checking patches."
    apply_patches lenient
fi

cd "$SRC/fbdoom"

echo "==> Cleaning previous build..."
make clean || true

echo "==> Cross-compiling fbdoom (wasm32, NOSDL=1)..."
# fbDOOM's own Makefile already wires NOSDL=1 to the framebuffer + null
# audio frontend; we just override the toolchain.
#
# LIBS="-lm" — wasm32posix-cc auto-injects channel_syscall.c plus the
# musl libc.a; passing -lc explicitly (the upstream Makefile default)
# would cause duplicate-symbol errors for fork / _Fork / __syscall_cp.
# We keep -lm because the SDK doesn't auto-link libm.
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -Iopl" \
     LDFLAGS="" \
     LIBS="-lm" \
     NOSDL=1

cp fbdoom "$HERE/fbdoom.wasm"

# fbDOOM doesn't fork — no wasm-fork-instrument step needed.
# (vs other ports here: dash forks via popen/system, so its build-dash.sh
# runs `wasm-fork-instrument` for the fork path.)

ls -la "$HERE/fbdoom.wasm"
echo "==> fbdoom.wasm built."

# Install into local-binaries/ (resolver priority 1) and the resolver
# scratch dir when invoked by xtask build-deps / archive-stage.
#
# `cd "$REPO_ROOT"` is load-bearing: install_local_binary uses
# `git rev-parse --show-toplevel` to locate the repo root, and we're
# still inside `$SRC/fbdoom` (a nested git clone) from the make step.
# Without the cd, git would return fbdoom's clone as the toplevel and
# we'd write into packages/registry/fbdoom/fbdoom-src/local-binaries/.
#
# No IWAD is bundled. The browser demo fetches the DOOM shareware
# `doom1.wad` at page load (id Software, freely redistributable) and
# caches it via the Cache API — see apps/browser-demos/pages/doom-mp/main.ts.
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary fbdoom "$HERE/fbdoom.wasm" fbdoom.wasm
