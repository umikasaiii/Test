/* DSLink - C API used by the JNI (Android) and Swift (iOS) shells.
 * All structured data crosses the boundary as "key=value\n" text (see kv.hpp). Returned strings are heap
 * allocated and must be released with dslink_free(). NULL means failure (see dslink_last_error()). */
#ifndef DSLINK_C_H
#define DSLINK_C_H
#ifdef __cplusplus
extern "C" {
#endif

#define DSLINK_PROTOCOL_VERSION 1

void dslink_free(char* p);
const char* dslink_last_error(void);

/* identity */
char* dslink_identity_load_or_create(const char* path);          /* device_id, player_name, nick, mac, created */
char* dslink_identity_rename(const char* path, const char* name); /* same keys; NULL if the name is invalid */
char* dslink_identity_bump_salt(const char* path);                /* new nickname => new MAC, after a MAC conflict */

/* network */
char* dslink_best_ipv4(void);                  /* found, ip, iface, kind, prefix, vpn */
int dslink_pick_port(int preferred);           /* 0 = none free */
char* dslink_sha256_file(const char* path);    /* lowercase hex or NULL */
char* dslink_validate_system_dir(const char* dir); /* bios7, bios9, firmware (status codes + messages), ready */
char* dslink_nds_info(const char* path);       /* status, message, title, game_code, unit_code, size, sha256 */

/* adverts */
char* dslink_advert_normalize(const char* kv); /* validates; returns canonical wire form or NULL */
char* dslink_advert_decode(const char* wire);  /* wire form -> kv or NULL */
char* dslink_compat_message(const char* code); /* compat code -> Italian text */

/* host: control server + optional UDP beacon */
void* dslink_host_start(const char* advertKv, const char* hostNick, const char* hostMac, int port, int beacon);
char* dslink_host_peers(void* h);  /* count=N, peerN_nick, peerN_mac, peerN_ip */
void dslink_host_stop(void* h);

/* client */
char* dslink_hello(const char* ip, int port, const char* clientInfoKv, const char* mac); /* ok, reachable, code, message, host_nick... */
void dslink_bye(const char* ip, int port, const char* deviceId);
char* dslink_probe(const char* ip, int port, int count); /* rtt/jitter/loss + quality + quality_label */

/* beacon listener (Android; iOS uses Bonjour) */
void* dslink_beacon_listen(void);
char* dslink_beacon_rooms(void* h);  /* count=N, roomN_<advert keys> */
void dslink_beacon_stop(void* h);

/* state machine */
void* dslink_sm_new(void);
int dslink_sm_event(void* h, const char* eventName, const char* info, int remainingPeers);
char* dslink_sm_state(void* h);  /* state, role, peers, last_error, last_disconnect */
void dslink_sm_free(void* h);

/* RetroArch launch */
char* dslink_launch_config(const char* planKv);        /* retroarch.cfg text */
char* dslink_launch_core_options(const char* planKv);
char* dslink_launch_netplay_extra(const char* planKv);

/* logging / diagnostics */
void dslink_log(const char* line);
char* dslink_log_dump(void);
char* dslink_diagnostics(const char* reportKv);

#ifdef __cplusplus
}
#endif
#endif
