#!/usr/bin/env bash
# Integration test (emulator level, Linux, no devices): two real RetroArch processes + the real melonDS DS core,
# configured *only* with what DSLink generates, must connect through RetroArch Netplay and start the core's
# multiplayer layer. Also checks that the DS MACs the core reports equal DSLink's derivation.
#
# usage: linux_netplay_smoke.sh <retroarch> <melondsds_libretro.so> <dslink_cfgtool>
# Not covered (needs Nintendo firmware + a licensed game): DS Download Play itself. See docs/MARIO_PARTY_DS.md.
set -u
RA=$1 CORE=$2 TOOL=$3
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
PORT=${PORT:-56012}
DEV_H=aaaa0000000000000000000000000000
DEV_C=bbbb0000000000000000000000000000
fail() { echo "FAIL: $*"; pkill -x "$(basename "$RA")" 2>/dev/null; exit 1; }
python3 "$HERE/make_test_rom.py" "$T/test.nds" || fail "rom generation"

setup() { # dir name dev hostip content   (dir "host" => host role, anything else => client role)
  local role=client; [ "$1" = host ] && role=host
  local d=$T/$1; mkdir -p "$d"/{system/"melonDS DS",saves,states,config}
  "$TOOL" $role "$d" "$CORE" "${5:--}" "$4" $PORT "$2" "$3" cfg > "$d/retroarch.cfg"
  "$TOOL" $role "$d" x "${5:--}" "$4" $PORT "$2" "$3" opts > "$d/config/melondsds.opt"
  # headless drivers: this is the only thing the test adds to DSLink's config
  printf 'video_driver = "null"\naudio_driver = "null"\ninput_driver = "null"\naudio_enable = "false"\n' >> "$d/retroarch.cfg"
}
setup host Alice $DEV_H - "$T/test.nds"
setup client Bob $DEV_C 127.0.0.1 "$T/test.nds"
NICK_H=$("$TOOL" host "$T/host" x - - $PORT Alice $DEV_H nick); MAC_H=$("$TOOL" host "$T/host" x - - $PORT Alice $DEV_H mac)
NICK_C=$("$TOOL" client "$T/client" x - - $PORT Bob $DEV_C nick); MAC_C=$("$TOOL" client "$T/client" x - - $PORT Bob $DEV_C mac)
[ "$MAC_H" != "$MAC_C" ] || fail "DSLink produced identical MACs"

( cd "$T/host" && timeout 60 "$RA" -v -c "$T/host/retroarch.cfg" -L "$CORE" -H --port $PORT --nick "$NICK_H" "$T/test.nds" --max-frames=4000000 > "$T/host.log" 2>&1 ) &
sleep 4
( cd "$T/client" && timeout 40 "$RA" -v -c "$T/client/retroarch.cfg" -L "$CORE" -C 127.0.0.1 --port $PORT --nick "$NICK_C" "$T/test.nds" --max-frames=4000000 > "$T/client.log" 2>&1 ) &
for i in $(seq 1 40); do grep -q "has joined as player 2" "$T/host.log" 2>/dev/null && break; sleep 0.5; done
sleep 3
pkill -x "$(basename "$RA")" 2>/dev/null; wait 2>/dev/null

grep -q "You have joined as player 1" "$T/host.log"            || fail "host did not start hosting"
grep -q "has joined as player 2" "$T/host.log"                 || fail "client never joined the host"
grep -q "You have joined as player 2" "$T/client.log"          || fail "client did not report joining"
grep -q "Starting multiplayer on libretro side" "$T/host.log"  || fail "host core did not start multiplayer"
grep -q "Starting multiplayer on libretro side" "$T/client.log"|| fail "client core did not start multiplayer"
grep -q "MAC: $MAC_H" "$T/host.log"                            || fail "host core MAC != DSLink MAC $MAC_H ($(grep 'MAC:' "$T/host.log"))"
grep -q "MAC: $MAC_C" "$T/client.log"                          || fail "client core MAC != DSLink MAC $MAC_C ($(grep 'MAC:' "$T/client.log"))"
echo "PASS: netplay host<->client up, core multiplayer started, MACs $MAC_H / $MAC_C match DSLink's derivation"

# No-cartridge client (the Download Play client): connects, core reports it needs bootable firmware.
setup dl Bob $DEV_C 127.0.0.1 ""
NICK_D=$("$TOOL" client "$T/dl" x - - $PORT Bob $DEV_C nick)
( cd "$T/host" && timeout 40 "$RA" -v -c "$T/host/retroarch.cfg" -L "$CORE" -H --port $PORT --nick "$NICK_H" "$T/test.nds" --max-frames=4000000 > "$T/host2.log" 2>&1 ) &
sleep 4
( cd "$T/dl" && timeout 15 "$RA" -v -c "$T/dl/retroarch.cfg" -L "$CORE" -C 127.0.0.1 --port $PORT --nick "$NICK_D" --max-frames=300 > "$T/dl.log" 2>&1 )
pkill -x "$(basename "$RA")" 2>/dev/null; wait 2>/dev/null
grep -q "melonds_boot_mode = \"native\"" "$T/dl/config/melondsds.opt" || fail "no-cartridge client is not set to native boot"
grep -q "You have joined as player 2" "$T/dl.log"                     || fail "no-cartridge client did not join the host"
grep -q "can't be used to boot to the DS menu" "$T/dl.log"            || fail "expected the core's 'needs bootable firmware' error without user firmware"
echo "PASS: no-cartridge client joins the host; without the user's firmware the core reports it cannot boot the DS menu (expected)"
rm -rf "$T"
