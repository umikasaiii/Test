#!/usr/bin/env bash
# Builds tests/rom/dslink_test_{1,2}.nds (two variants: different background colour and tone). Needs gcc-arm-none-eabi.
set -euo pipefail
cd "$(dirname "$0")"; OUT=${1:-.}
for id in 1 2; do
  hz=$((id == 1 ? 440 : 660))
  arm-none-eabi-gcc -mcpu=arm946e-s -marm -O2 -ffreestanding -nostdlib -DTEST_ID=$id -Wl,-T,link9.ld -o /tmp/a9_$id.elf start9.S arm9.c
  arm-none-eabi-gcc -mcpu=arm7tdmi -marm -O2 -ffreestanding -nostdlib -DTONE_HZ=$hz -DTEST_ID=$id -Wl,-T,link7.ld -o /tmp/a7_$id.elf start7.S arm7.c
  arm-none-eabi-objcopy -O binary /tmp/a9_$id.elf /tmp/a9_$id.bin
  arm-none-eabi-objcopy -O binary /tmp/a7_$id.elf /tmp/a7_$id.bin
  python3 pack_nds.py /tmp/a9_$id.bin /tmp/a7_$id.bin "$OUT/dslink_test_$id.nds" "DSLINKTEST$id"
done
