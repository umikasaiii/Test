# Libretro host (`runtime/src/libretro_host.*`)

The part of the Runtime that plays RetroArch's role towards a core. Everything below is implemented and exercised by the tests; anything
not listed is logged (`unhandled environment cmd N`) and counted in the metrics, never silently accepted.

## Environment calls (`retro_environment`)

| Group | Commands | Behaviour |
|---|---|---|
| Directories | `GET_SYSTEM_DIRECTORY`, `GET_SAVE_DIRECTORY` | from `--system` / `--save` (created if missing) |
| Identity | `GET_USERNAME`, `GET_LANGUAGE` | `--username`, English |
| Video | `SET_PIXEL_FORMAT` (XRGB8888 only; others refused), `SET_GEOMETRY`, `SET_SYSTEM_AV_INFO`, `SET_ROTATION` | geometry updates are recorded; the encoder scales whatever size arrives to its fixed output size |
| Content | `SET_SUPPORT_NO_GAME`, `SET_CONTENT_INFO_OVERRIDE`, `SET_SUBSYSTEM_INFO`, `SET_MEMORY_MAPS` | boot without content when declared |
| Core options | `SET_CORE_OPTIONS` v0/v1/v2 and `_INTL`, `SET_VARIABLES`, `GET_CORE_OPTIONS_VERSION`(2), `GET_VARIABLE`, `SET_VARIABLE`, `GET_VARIABLE_UPDATE`, `SET_CORE_OPTIONS_DISPLAY`, `…_UPDATE_DISPLAY_CALLBACK` | defaults from the core's definitions, overridden by `--options`; returned strings stay valid until the next read of the same key |
| Input | `GET_INPUT_BITMASKS`, `SET_INPUT_DESCRIPTORS`, `SET_CONTROLLER_INFO`, `GET_INPUT_DEVICE_CAPABILITIES` | 4 RetroPad ports, bitmask polling, pointer device |
| Timing | `GET_TARGET_REFRESH_RATE`, `SET_FRAME_TIME_CALLBACK`, `GET_FASTFORWARDING`, `SET_FASTFORWARDING_OVERRIDE`, `GET_THROTTLE_STATE` | never fast-forwards |
| Messages/log | `GET_LOG_INTERFACE`, `SET_MESSAGE`, `SET_MESSAGE_EXT`, `GET_MESSAGE_INTERFACE_VERSION`(1) | forwarded to the Runtime log with the core's level |
| Misc | `SET_PROC_ADDRESS_CALLBACK`, `SET_SUPPORT_ACHIEVEMENTS`, `GET_DEVICE_POWER`, `SHUTDOWN` | no-ops / "plugged in" / stop |
| Multiplayer | `SET_NETPACKET_INTERFACE` | hands the core's `retro_netpacket_callback` to the MpBridge |
| Not offered | VFS, microphone, rumble, sensors, LED, camera, location, hardware rendering, disk control | the core falls back (melonDS logs the fallback; same lines appear under RetroArch for the unsupported ones) |

## Callbacks
* `video_refresh`: copies XRGB8888 rows (honouring `pitch`) into the encoder's frame.
* `audio_sample_batch` (and `audio_sample`): s16 stereo into a ring that the Opus encoder drains in 20 ms packets; the A/B test
  compares the tone frequency against RetroArch (443 vs 440 Hz = measurement resolution).
* `input_state`: `RETRO_DEVICE_JOYPAD` (per-port atomics, bitmask or per-id), `RETRO_DEVICE_POINTER` X/Y/PRESSED from the touch state
  (the DS core expects the full-frame range ±32767 and handles the two-screen layout itself), other devices return 0.
* `input_poll`: no-op (state is event driven from the link).

## Multiple controllers
`InputState` exists for 4 ports; the gateway currently maps one browser to port 0 of its own Runtime. PS1 (two pads, one console)
will use ports 0/1 of a single Runtime — the host side is ready, the gateway/UI mapping is not written (see LIBRARY.md).

## Core options
Written per console from `dslink_cfgtool … opts`; the same file is used by the RetroArch reference path, which is how both
frontends get byte-identical options in the A/B test.
