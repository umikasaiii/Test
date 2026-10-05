// JNI bridge: com.dslink.emulator.DsLink <-> dslink C API. Strings only; failures return null.
#include <jni.h>

#include <string>

#include "dslink/dslink_c.h"

namespace {
std::string str(JNIEnv* env, jstring s) {
    if (!s) return {};
    const char* c = env->GetStringUTFChars(s, nullptr);
    std::string r = c ? c : "";
    if (c) env->ReleaseStringUTFChars(s, c);
    return r;
}
jstring out(JNIEnv* env, char* p) {
    if (!p) return nullptr;
    jstring j = env->NewStringUTF(p);
    dslink_free(p);
    return j;
}
}  // namespace

#define J(ret, name, ...) extern "C" JNIEXPORT ret JNICALL Java_com_dslink_emulator_DsLink_##name(JNIEnv* env, jclass, ##__VA_ARGS__)

J(jstring, identityLoadOrCreate, jstring p) { return out(env, dslink_identity_load_or_create(str(env, p).c_str())); }
J(jstring, identityRename, jstring p, jstring n) { return out(env, dslink_identity_rename(str(env, p).c_str(), str(env, n).c_str())); }
J(jstring, identityBumpSalt, jstring p) { return out(env, dslink_identity_bump_salt(str(env, p).c_str())); }
J(jstring, bestIPv4) { return out(env, dslink_best_ipv4()); }
J(jint, pickPort, jint preferred) { return dslink_pick_port(preferred); }
J(jstring, sha256File, jstring p) { return out(env, dslink_sha256_file(str(env, p).c_str())); }
J(jstring, validateSystemDir, jstring d) { return out(env, dslink_validate_system_dir(str(env, d).c_str())); }
J(jstring, ndsInfo, jstring p) { return out(env, dslink_nds_info(str(env, p).c_str())); }
J(jstring, advertNormalize, jstring kv) { return out(env, dslink_advert_normalize(str(env, kv).c_str())); }
J(jstring, advertDecode, jstring w) { return out(env, dslink_advert_decode(str(env, w).c_str())); }
J(jstring, compatMessage, jstring c) { return out(env, dslink_compat_message(str(env, c).c_str())); }
J(jlong, hostStart, jstring ad, jstring nick, jstring mac, jint port, jboolean beacon) {
    return reinterpret_cast<jlong>(dslink_host_start(str(env, ad).c_str(), str(env, nick).c_str(), str(env, mac).c_str(), port, beacon ? 1 : 0));
}
J(jstring, hostPeers, jlong h) { return out(env, dslink_host_peers(reinterpret_cast<void*>(h))); }
J(void, hostStop, jlong h) { dslink_host_stop(reinterpret_cast<void*>(h)); }
J(jstring, hello, jstring ip, jint port, jstring info, jstring mac) {
    return out(env, dslink_hello(str(env, ip).c_str(), port, str(env, info).c_str(), str(env, mac).c_str()));
}
J(void, bye, jstring ip, jint port, jstring dev) { dslink_bye(str(env, ip).c_str(), port, str(env, dev).c_str()); }
J(jstring, probe, jstring ip, jint port, jint count) { return out(env, dslink_probe(str(env, ip).c_str(), port, count)); }
J(jlong, beaconListen) { return reinterpret_cast<jlong>(dslink_beacon_listen()); }
J(jstring, beaconRooms, jlong h) { return out(env, dslink_beacon_rooms(reinterpret_cast<void*>(h))); }
J(void, beaconStop, jlong h) { dslink_beacon_stop(reinterpret_cast<void*>(h)); }
J(jlong, smNew) { return reinterpret_cast<jlong>(dslink_sm_new()); }
J(jboolean, smEvent, jlong h, jstring ev, jstring info, jint remaining) {
    return dslink_sm_event(reinterpret_cast<void*>(h), str(env, ev).c_str(), str(env, info).c_str(), remaining) ? JNI_TRUE : JNI_FALSE;
}
J(jstring, smState, jlong h) { return out(env, dslink_sm_state(reinterpret_cast<void*>(h))); }
J(void, smFree, jlong h) { dslink_sm_free(reinterpret_cast<void*>(h)); }
J(jstring, launchConfig, jstring k) { return out(env, dslink_launch_config(str(env, k).c_str())); }
J(jstring, launchCoreOptions, jstring k) { return out(env, dslink_launch_core_options(str(env, k).c_str())); }
J(jstring, launchNetplayExtra, jstring k) { return out(env, dslink_launch_netplay_extra(str(env, k).c_str())); }
J(void, log, jstring l) { dslink_log(str(env, l).c_str()); }
J(jstring, logDump) { return out(env, dslink_log_dump()); }
J(jstring, diagnostics, jstring k) { return out(env, dslink_diagnostics(str(env, k).c_str())); }
J(jstring, lastError) { return env->NewStringUTF(dslink_last_error()); }
