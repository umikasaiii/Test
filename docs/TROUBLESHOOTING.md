# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| iOS: "Accesso alla rete locale disattivato" | iOS Settings → DSLink → enable *Rete locale*; then reopen *Unisciti*. |
| No rooms appear | Both devices must be on the **same** Wi-Fi. Guest networks and "client/AP isolation" block device-to-device traffic. Try one phone's hotspot. Then use *Inserisci IP manualmente* (host: *Mostra dati connessione*). |
| "Host non raggiungibile" | Wrong IP/port, host room closed, or isolation. Check both devices' subnet in Diagnostica (first three numbers should match). |
| "Le due versioni di DSLink sono diverse" | Install the same DSLink version on both devices. |
| "File di sistema mancanti" / DS menu error on client | Import your own `bios7.bin`, `bios9.bin`, `firmware.bin` (Impostazioni). The replacement firmware cannot boot the DS menu. |
| "Rete insufficiente" | Move closer to the router, disable VPN, or use a hotspot. DS wireless needs a low-latency, low-jitter LAN. |
| VPN warning | DS local wireless does not work through VPNs/tunnels. Turn it off. |
| "Porta occupata" | Another app uses the Netplay port (TCP/UDP 55435+). DSLink picks the next free one automatically; close other emulators if none is free. |
| Dropped when the phone locks / app goes to background | Netplay cannot survive suspension; keep the screen on (DSLink does while hosting/joining). |
| Wi-Fi switched off during a session | The session ends; reconnect and rejoin. |

Send the output of *Impostazioni → Avanzate → Diagnostica multiplayer → Copia log* with any bug report. It contains no ROM,
BIOS or firmware data and no file-system paths.
